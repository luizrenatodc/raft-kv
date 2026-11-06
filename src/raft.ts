/**
 * Núcleo do Raft como máquina de estados pura.
 *
 * Este arquivo não conhece relógio, rede nem disco. Ele recebe eventos
 * (`tick`, `receber`, `propor`) e devolve mensagens por `saida`. Essa separação
 * é o que permite testar o algoritmo em um simulador determinístico: a mesma
 * semente reproduz exatamente a mesma execução, inclusive a falha.
 */

export type Id = number;

export interface Comando {
  cliente: string;
  seq: number;
  tipo: "set" | "cas" | "noop";
  chave: string;
  valor?: string;
  esperado?: string | null;
}

export interface Entrada {
  termo: number;
  comando: Comando;
}

/** Estado que precisa sobreviver a uma queda (seção 5 do artigo do Raft). */
export interface Persistente {
  termo: number;
  votouEm: Id | null;
  log: Entrada[];
}

export type Mensagem =
  | { tipo: "pedeVoto"; de: Id; para: Id; termo: number; ultimoIndice: number; ultimoTermo: number; pre: boolean }
  | { tipo: "voto"; de: Id; para: Id; termo: number; concedido: boolean; pre: boolean }
  | { tipo: "anexar"; de: Id; para: Id; termo: number; anteriorIndice: number; anteriorTermo: number; entradas: Entrada[]; commit: number; rodada: number }
  | { tipo: "anexado"; de: Id; para: Id; termo: number; ok: boolean; indice: number; conflito: number; rodada: number };

export type Papel = "seguidor" | "pre-candidato" | "candidato" | "lider";

export interface Config {
  eleicaoMin: number;
  eleicaoMax: number;
  batida: number;
  loteMaximo: number;
}

export const CONFIG_PADRAO: Config = { eleicaoMin: 15, eleicaoMax: 30, batida: 4, loteMaximo: 32 };

/**
 * Defeitos injetáveis. Existem para provar que os testes têm dentes: cada um
 * remove uma regra de segurança, e a suíte precisa acusar a violação.
 */
export interface Defeitos {
  esquecerVoto?: boolean;
  commitDeTermoAntigo?: boolean;
  leituraSemConfirmar?: boolean;
  ignorarLogNoVoto?: boolean;
}

interface LeituraPendente {
  rodada: number;
  indice: number;
  acks: Set<Id>;
  pronta: () => void;
}

export class NoRaft {
  papel: Papel = "seguidor";
  lider: Id | null = null;
  commit = 0;
  aplicado = 0;
  saida: Mensagem[] = [];

  private prazo = 0;
  private relogio = 0;
  private votos = new Set<Id>();
  private proximo = new Map<Id, number>();
  private casado = new Map<Id, number>();
  private rodada = 0;
  private proximaBatida = 0;
  private ultimoContatoLider = -Infinity;
  private leituras: LeituraPendente[] = [];
  readonly id: Id;
  readonly pares: Id[];
  readonly disco: Persistente;
  private readonly cfg: Config;
  private readonly sorteio: () => number;
  private readonly aplicar: (indice: number, c: Comando) => void;
  private readonly defeitos: Defeitos;

  constructor(
    id: Id,
    pares: Id[],
    disco: Persistente,
    sorteio: () => number,
    aplicar: (indice: number, c: Comando) => void,
    cfg: Config = CONFIG_PADRAO,
    defeitos: Defeitos = {},
  ) {
    this.id = id;
    this.pares = pares;
    this.disco = disco;
    this.sorteio = sorteio;
    this.aplicar = aplicar;
    this.cfg = cfg;
    this.defeitos = defeitos;
    this.reiniciarPrazo();
  }

  get termo(): number {
    return this.disco.termo;
  }
  get ultimoIndice(): number {
    return this.disco.log.length;
  }
  private get quorum(): number {
    return Math.floor((this.pares.length + 1) / 2) + 1;
  }
  private termoEm(indice: number): number {
    return indice === 0 ? 0 : (this.disco.log[indice - 1]?.termo ?? 0);
  }
  private reiniciarPrazo(): void {
    const { eleicaoMin: a, eleicaoMax: b } = this.cfg;
    this.prazo = this.relogio + a + Math.floor(this.sorteio() * (b - a));
  }

  tick(): void {
    this.relogio++;
    if (this.papel === "lider") {
      if (this.relogio >= this.proximaBatida) this.difundir();
      return;
    }
    if (this.relogio >= this.prazo) this.iniciarPreVoto();
  }

  /**
   * Pré-voto: antes de incrementar o termo, o nó pergunta se venceria.
   * Sem isso, um nó isolado volta da partição com termo alto e derruba um
   * líder saudável sem nenhum motivo.
   */
  private iniciarPreVoto(): void {
    this.papel = "pre-candidato";
    this.lider = null;
    this.votos = new Set([this.id]);
    this.reiniciarPrazo();
    this.pedirVotos(this.termo + 1, true);
    this.verificarVitoriaPre();
  }

  private iniciarEleicao(): void {
    this.papel = "candidato";
    this.disco.termo++;
    this.disco.votouEm = this.id;
    this.votos = new Set([this.id]);
    this.reiniciarPrazo();
    this.pedirVotos(this.termo, false);
    if (this.votos.size >= this.quorum) this.assumir();
  }

  private pedirVotos(termo: number, pre: boolean): void {
    const ultimoIndice = this.ultimoIndice;
    const ultimoTermo = this.termoEm(ultimoIndice);
    for (const para of this.pares) {
      this.saida.push({ tipo: "pedeVoto", de: this.id, para, termo, ultimoIndice, ultimoTermo, pre });
    }
  }

  private verificarVitoriaPre(): void {
    if (this.papel === "pre-candidato" && this.votos.size >= this.quorum) this.iniciarEleicao();
  }

  private assumir(): void {
    this.papel = "lider";
    this.lider = this.id;
    this.proximo = new Map(this.pares.map((p) => [p, this.ultimoIndice + 1]));
    this.casado = new Map(this.pares.map((p) => [p, 0]));
    // Entrada vazia do novo termo: é ela que destrava o commit do que veio antes.
    this.disco.log.push({ termo: this.termo, comando: { cliente: "", seq: 0, tipo: "noop", chave: "" } });
    this.avancarCommit();
    this.difundir();
  }

  private rebaixar(termo: number): void {
    if (termo > this.termo) {
      this.disco.termo = termo;
      this.disco.votouEm = null;
    }
    if (this.papel !== "seguidor") this.reiniciarPrazo();
    this.papel = "seguidor";
    this.leituras = [];
  }

  /** Propõe um comando. Devolve o índice ou null quando este nó não é o líder. */
  propor(comando: Comando): number | null {
    if (this.papel !== "lider") return null;
    this.disco.log.push({ termo: this.termo, comando });
    this.avancarCommit();
    this.difundir();
    return this.ultimoIndice;
  }

  /**
   * ReadIndex (seção 6.4 da tese): a leitura só é servida depois que um quórum
   * confirma, em uma rodada iniciada após o pedido, que este nó ainda é o líder.
   * Sem isso, um líder isolado responderia com dado velho.
   */
  lerLinearizavel(pronta: () => void): boolean {
    if (this.papel !== "lider") return false;
    if (this.defeitos.leituraSemConfirmar) {
      pronta();
      return true;
    }
    // Só é seguro depois de commitar uma entrada do próprio termo.
    if (this.termoEm(this.commit) !== this.termo) return false;
    const leitura: LeituraPendente = { rodada: this.rodada + 1, indice: this.commit, acks: new Set([this.id]), pronta };
    this.leituras.push(leitura);
    this.difundir();
    this.resolverLeituras();
    return true;
  }

  private resolverLeituras(): void {
    this.leituras = this.leituras.filter((l) => {
      if (l.acks.size < this.quorum || this.aplicado < l.indice) return true;
      l.pronta();
      return false;
    });
  }

  private difundir(): void {
    this.rodada++;
    this.proximaBatida = this.relogio + this.cfg.batida;
    for (const para of this.pares) this.enviarAnexar(para);
  }

  private enviarAnexar(para: Id): void {
    const proximo = this.proximo.get(para) ?? 1;
    const anteriorIndice = proximo - 1;
    this.saida.push({
      tipo: "anexar",
      de: this.id,
      para,
      termo: this.termo,
      anteriorIndice,
      anteriorTermo: this.termoEm(anteriorIndice),
      entradas: this.disco.log.slice(anteriorIndice, anteriorIndice + this.cfg.loteMaximo),
      commit: this.commit,
      rodada: this.rodada,
    });
  }

  receber(m: Mensagem): void {
    const prePedido = m.tipo === "pedeVoto" && m.pre;
    const preResposta = m.tipo === "voto" && m.pre;
    if (!prePedido && !preResposta && m.termo > this.termo) this.rebaixar(m.termo);
    if (preResposta && m.termo > this.termo + 1) this.rebaixar(m.termo);

    switch (m.tipo) {
      case "pedeVoto":
        return this.aoPedirVoto(m);
      case "voto":
        return this.aoVoto(m);
      case "anexar":
        return this.aoAnexar(m);
      case "anexado":
        return this.aoAnexado(m);
    }
  }

  private logAtualizado(m: { ultimoIndice: number; ultimoTermo: number }): boolean {
    if (this.defeitos.ignorarLogNoVoto) return true;
    const meu = this.termoEm(this.ultimoIndice);
    return m.ultimoTermo > meu || (m.ultimoTermo === meu && m.ultimoIndice >= this.ultimoIndice);
  }

  private aoPedirVoto(m: Extract<Mensagem, { tipo: "pedeVoto" }>): void {
    let concedido: boolean;
    if (m.pre) {
      // Quem ouviu um líder há pouco recusa: protege contra nó que só perdeu a conexão.
      const liderVivo = this.relogio - this.ultimoContatoLider < this.cfg.eleicaoMin || this.papel === "lider";
      concedido = m.termo > this.termo && !liderVivo && this.logAtualizado(m);
      this.saida.push({ tipo: "voto", de: this.id, para: m.de, termo: concedido ? m.termo : this.termo, concedido, pre: true });
      return;
    }
    const livre = this.disco.votouEm === null || this.disco.votouEm === m.de;
    concedido = m.termo === this.termo && livre && this.logAtualizado(m);
    if (concedido) {
      this.disco.votouEm = m.de;
      this.reiniciarPrazo();
    }
    this.saida.push({ tipo: "voto", de: this.id, para: m.de, termo: this.termo, concedido, pre: false });
  }

  private aoVoto(m: Extract<Mensagem, { tipo: "voto" }>): void {
    if (m.pre) {
      if (this.papel === "pre-candidato" && m.concedido && m.termo === this.termo + 1) {
        this.votos.add(m.de);
        this.verificarVitoriaPre();
      }
      return;
    }
    if (this.papel !== "candidato" || m.termo !== this.termo || !m.concedido) return;
    this.votos.add(m.de);
    if (this.votos.size >= this.quorum) this.assumir();
  }

  private aoAnexar(m: Extract<Mensagem, { tipo: "anexar" }>): void {
    const responder = (ok: boolean, indice: number, conflito = 0) =>
      this.saida.push({ tipo: "anexado", de: this.id, para: m.de, termo: this.termo, ok, indice, conflito, rodada: m.rodada });

    if (m.termo < this.termo) return void responder(false, 0);
    if (this.papel !== "seguidor") this.rebaixar(m.termo);
    this.lider = m.de;
    this.ultimoContatoLider = this.relogio;
    this.reiniciarPrazo();

    if (m.anteriorIndice > this.ultimoIndice) return void responder(false, 0, this.ultimoIndice + 1);
    if (this.termoEm(m.anteriorIndice) !== m.anteriorTermo) {
      // Recuo rápido: pula o termo conflitante inteiro em vez de uma entrada por vez.
      const termoRuim = this.termoEm(m.anteriorIndice);
      let i = m.anteriorIndice;
      while (i > 1 && this.termoEm(i - 1) === termoRuim) i--;
      return void responder(false, 0, i);
    }

    let indice = m.anteriorIndice;
    for (const entrada of m.entradas) {
      indice++;
      if (indice <= this.ultimoIndice && this.termoEm(indice) !== entrada.termo) {
        this.disco.log.length = indice - 1; // só trunca em conflito real: mensagem atrasada não apaga nada
      }
      if (indice > this.ultimoIndice) this.disco.log.push(entrada);
    }
    if (m.commit > this.commit) {
      this.commit = Math.min(m.commit, indice);
      this.aplicarPendentes();
    }
    responder(true, indice);
  }

  private aoAnexado(m: Extract<Mensagem, { tipo: "anexado" }>): void {
    if (this.papel !== "lider" || m.termo !== this.termo) return;
    for (const l of this.leituras) if (m.rodada >= l.rodada) l.acks.add(m.de);
    if (m.ok) {
      if (m.indice > (this.casado.get(m.de) ?? 0)) {
        this.casado.set(m.de, m.indice);
        this.proximo.set(m.de, m.indice + 1);
        this.avancarCommit();
      }
      if ((this.proximo.get(m.de) ?? 1) <= this.ultimoIndice) this.enviarAnexar(m.de);
    } else if (m.conflito > 0) {
      this.proximo.set(m.de, Math.max(1, Math.min(m.conflito, this.ultimoIndice)));
      this.enviarAnexar(m.de);
    }
    this.resolverLeituras();
  }

  private avancarCommit(): void {
    const indices = [this.ultimoIndice, ...this.casado.values()].sort((a, b) => b - a);
    const candidato = indices[this.quorum - 1] ?? 0;
    if (candidato <= this.commit) return;
    // Figura 8 do artigo: líder só commita por contagem entradas do próprio termo.
    if (!this.defeitos.commitDeTermoAntigo && this.termoEm(candidato) !== this.termo) return;
    this.commit = candidato;
    this.aplicarPendentes();
    this.resolverLeituras();
  }

  private aplicarPendentes(): void {
    while (this.aplicado < this.commit) {
      this.aplicado++;
      this.aplicar(this.aplicado, this.disco.log[this.aplicado - 1]!.comando);
    }
  }
}
