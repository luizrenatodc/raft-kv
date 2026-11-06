/**
 * Simulador determinístico: rede, relógio, quedas e partições vêm de uma única
 * semente. Uma falha encontrada aqui é reproduzida com `--semente N`, sem
 * depender de sorte, no estilo da simulação usada pela FoundationDB.
 */
import { Kv } from "./kv.ts";
import { CONFIG_PADRAO, NoRaft, type Comando, type Defeitos, type Id, type Mensagem, type Persistente } from "./raft.ts";
import type { Operacao } from "./linearizabilidade.ts";

export function prng(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Cenario {
  semente: number;
  nos?: number;
  duracao?: number;
  perda?: number;
  atrasoMax?: number;
  chanceQueda?: number;
  chanceParticao?: number;
  /** Chance, por tick, de um nó caído voltar. */
  chanceVolta?: number;
  clientes?: number;
  defeitos?: Defeitos;
  /** Guarda quadros para o painel visual. */
  gravar?: boolean;
}

export interface Violacao {
  regra: string;
  detalhe: string;
  tempo: number;
}

interface Pedido {
  cliente: string;
  seq: number;
  op: Operacao;
  chave: string;
  prazo: number;
  enviadoPara: Id;
}

export interface Quadro {
  t: number;
  nos: { id: Id; papel: string; termo: number; log: number; commit: number; vivo: boolean; grupo: number }[];
  msgs: { de: Id; para: Id; tipo: string }[];
  evento?: string;
}

export interface Resultado {
  violacoes: Violacao[];
  historicos: Map<string, Operacao[]>;
  metricas: { eleicoes: number; quedas: number; particoes: number; concluidas: number; desistencias: number; mensagens: number; perdidas: number; commitado: number };
  quadros: Quadro[];
}

const CHAVES = ["a", "b", "c"];

export function simular(c: Cenario): Resultado {
  const n = c.nos ?? 5;
  const duracao = c.duracao ?? 3000;
  const perda = c.perda ?? 0.05;
  const atrasoMax = c.atrasoMax ?? 6;
  const chanceQueda = c.chanceQueda ?? 0.002;
  const chanceParticao = c.chanceParticao ?? 0.002;
  const chanceVolta = c.chanceVolta ?? 0.02;
  const defeitos = c.defeitos ?? {};
  const r = prng(c.semente);
  const ids = Array.from({ length: n }, (_, i) => i);

  const discos: Persistente[] = ids.map(() => ({ termo: 0, votouEm: null, log: [] }));
  const kvs: Kv[] = ids.map(() => new Kv());
  const aplicados: Map<number, Comando>[] = ids.map(() => new Map());
  const commitGlobal = new Map<number, string>();
  const violacoes: Violacao[] = [];
  const lideresPorTermo = new Map<number, Id>();
  const vivos = ids.map(() => true);
  let grupo = ids.map(() => 0);
  let fimParticao = -1;
  let t = 0;
  const metricas = { eleicoes: 0, quedas: 0, particoes: 0, concluidas: 0, desistencias: 0, mensagens: 0, perdidas: 0, commitado: 0 };
  const quadros: Quadro[] = [];
  let evento: string | undefined;

  const violar = (regra: string, detalhe: string) => {
    if (violacoes.length < 20) violacoes.push({ regra, detalhe, tempo: t });
  };

  const criarNo = (id: Id): NoRaft => {
    kvs[id] = new Kv();
    aplicados[id] = new Map();
    return new NoRaft(
      id,
      ids.filter((x) => x !== id),
      discos[id]!,
      r,
      (indice, comando) => {
        const assinatura = JSON.stringify(comando);
        const anterior = commitGlobal.get(indice);
        if (anterior !== undefined && anterior !== assinatura) {
          violar("segurança da máquina de estados", `índice ${indice} aplicado com comandos diferentes`);
        }
        commitGlobal.set(indice, assinatura);
        aplicados[id]!.set(indice, comando);
        kvs[id]!.aplicar(comando);
      },
      CONFIG_PADRAO,
      defeitos,
    );
  };
  const nos = ids.map(criarNo);

  const fila: { quando: number; m: Mensagem }[] = [];
  const ligados = (a: Id, b: Id) => grupo[a] === grupo[b];

  const coletar = (no: NoRaft) => {
    for (const m of no.saida) {
      metricas.mensagens++;
      if (r() < perda) {
        metricas.perdidas++;
        continue;
      }
      fila.push({ quando: t + 1 + Math.floor(r() * atrasoMax), m });
    }
    no.saida = [];
  };

  // Clientes: cada um faz uma operação por vez sobre uma das chaves.
  const historicos = new Map<string, Operacao[]>(CHAVES.map((k) => [k, []]));
  const clientes = Array.from({ length: c.clientes ?? 4 }, (_, i) => ({ nome: `c${i}`, seq: 0, pedido: null as Pedido | null, descanso: 0 }));
  let proximoOp = 0;

  const concluir = (cl: (typeof clientes)[number], saida: Operacao["saida"]) => {
    const p = cl.pedido;
    if (!p) return;
    p.op.fim = t;
    p.op.saida = saida;
    metricas.concluidas++;
    cl.pedido = null;
    cl.descanso = 1 + Math.floor(r() * 10);
  };

  const iniciar = (cl: (typeof clientes)[number]) => {
    const chave = CHAVES[Math.floor(r() * CHAVES.length)]!;
    const sorte = r();
    const op: Operacao =
      sorte < 0.4
        ? { id: proximoOp++, inicio: t, fim: Infinity, tipo: "leitura" }
        : sorte < 0.8
          ? { id: proximoOp, inicio: t, fim: Infinity, tipo: "escrita", valor: `v${proximoOp++}` }
          : { id: proximoOp, inicio: t, fim: Infinity, tipo: "cas", valor: `v${proximoOp++}`, esperado: null };
    historicos.get(chave)!.push(op);
    cl.seq++;
    cl.pedido = { cliente: cl.nome, seq: cl.seq, op, chave, prazo: t + 60, enviadoPara: -1 };
  };

  const tentar = (cl: (typeof clientes)[number]) => {
    const p = cl.pedido!;
    const lider = nos.find((x, i) => vivos[i] && x.papel === "lider" && (p.enviadoPara === -1 || r() < 0.5));
    if (!lider) return;
    const alvo = lider.id;
    if (p.op.tipo === "leitura") {
      if (p.enviadoPara !== -1) return; // uma leitura em voo por vez
      const iniciou = lider.lerLinearizavel(() => {
        if (cl.pedido === p) concluir(cl, kvs[alvo]!.dados.get(p.chave) ?? null);
      });
      if (iniciou && cl.pedido === p) p.enviadoPara = alvo;
      return;
    }
    if (p.enviadoPara === -1) {
      const comando: Comando = { cliente: p.cliente, seq: p.seq, tipo: p.op.tipo === "cas" ? "cas" : "set", chave: p.chave, valor: p.op.valor, esperado: p.op.esperado };
      if (lider.propor(comando) !== null) p.enviadoPara = alvo;
    }
  };

  const verificarInvariantes = () => {
    for (const no of nos) {
      if (!vivos[no.id] || no.papel !== "lider") continue;
      const dono = lideresPorTermo.get(no.termo);
      if (dono === undefined) {
        lideresPorTermo.set(no.termo, no.id);
        metricas.eleicoes++;
        evento = `nó ${no.id} eleito no termo ${no.termo}`;
      } else if (dono !== no.id) {
        violar("segurança da eleição", `nós ${dono} e ${no.id} lideraram o termo ${no.termo}`);
      }
    }
  };

  while (t < duracao) {
    t++;

    // Falhas sorteadas param 300 ticks antes do fim, para o sistema convergir.
    if (t < duracao - 300) {
      if (r() < chanceQueda) {
        const alvo = Math.floor(r() * n);
        if (vivos[alvo] && vivos.filter(Boolean).length > 1) {
          vivos[alvo] = false;
          metricas.quedas++;
          evento = `nó ${alvo} caiu`;
          if (defeitos.esquecerVoto) discos[alvo]!.votouEm = null;
        }
      }
      if (fimParticao < t && r() < chanceParticao) {
        grupo = ids.map(() => (r() < 0.5 ? 0 : 1));
        fimParticao = t + 40 + Math.floor(r() * 200);
        metricas.particoes++;
        evento = `rede partida: ${ids.filter((i) => grupo[i] === 0).join(",")} | ${ids.filter((i) => grupo[i] === 1).join(",")}`;
      }
    }
    if (fimParticao === t || t === duracao - 300) {
      grupo = ids.map(() => 0);
      fimParticao = -1;
      evento = "partição curada";
    }
    for (const i of ids) {
      if (!vivos[i] && (r() < chanceVolta || t >= duracao - 300)) {
        vivos[i] = true;
        nos[i] = criarNo(i);
        evento = `nó ${i} voltou`;
      }
    }

    const entregues: { de: Id; para: Id; tipo: string }[] = [];
    for (let i = fila.length - 1; i >= 0; i--) {
      const item = fila[i]!;
      if (item.quando > t) continue;
      fila.splice(i, 1);
      const { m } = item;
      if (!vivos[m.para] || !ligados(m.de, m.para)) continue;
      nos[m.para]!.receber(m);
      if (c.gravar) entregues.push({ de: m.de, para: m.para, tipo: m.tipo });
    }

    for (const i of ids) if (vivos[i]) nos[i]!.tick();

    for (const cl of clientes) {
      if (t >= duracao - 120) {
        if (cl.pedido && t > cl.pedido.prazo) {
          metricas.desistencias++;
          cl.pedido = null;
        }
        continue;
      }
      if (!cl.pedido) {
        if (cl.descanso-- <= 0) iniciar(cl);
        else continue;
      }
      const p = cl.pedido!;
      if (p.op.tipo !== "leitura" && p.enviadoPara !== -1) {
        const kv = nos.map((x, i) => (vivos[i] ? kvs[i]!.resultadoDe(p.cliente, p.seq) : undefined)).find((x) => x !== undefined);
        if (kv !== undefined) {
          concluir(cl, p.op.tipo === "cas" ? kv : undefined);
          continue;
        }
      }
      if (t > p.prazo) {
        // Desistir deixa a operação indeterminada: pode ter sido aplicada ou não.
        metricas.desistencias++;
        cl.pedido = null;
        cl.descanso = 5;
        continue;
      }
      tentar(cl);
    }

    for (const i of ids) if (vivos[i]) coletar(nos[i]!);
    verificarInvariantes();

    if (c.gravar && (t % 2 === 0 || evento)) {
      quadros.push({
        t,
        nos: nos.map((x, i) => ({ id: i, papel: vivos[i] ? x.papel : "fora", termo: x.termo, log: x.ultimoIndice, commit: x.commit, vivo: vivos[i]!, grupo: grupo[i]! })),
        msgs: entregues.slice(0, 12),
        evento,
      });
    }
    evento = undefined;
  }

  metricas.commitado = commitGlobal.size;
  return { violacoes, historicos, metricas, quadros };
}
