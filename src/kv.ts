import type { Comando } from "./raft.ts";

/**
 * Máquina de estados replicada.
 *
 * A tabela de sessões dá semântica de execução única: um cliente que repete um
 * pedido após timeout não aplica o comando duas vezes, mesmo que a repetição
 * chegue a outro líder. A tabela faz parte do estado replicado de propósito.
 */
export class Kv {
  dados = new Map<string, string>();
  private sessoes = new Map<string, { seq: number; resultado: boolean }>();

  aplicar(c: Comando): boolean {
    if (c.tipo === "noop") return true;
    const sessao = this.sessoes.get(c.cliente);
    if (sessao && sessao.seq >= c.seq) return sessao.resultado;

    let resultado = true;
    if (c.tipo === "set") this.dados.set(c.chave, c.valor ?? "");
    if (c.tipo === "cas") {
      resultado = (this.dados.get(c.chave) ?? null) === (c.esperado ?? null);
      if (resultado) this.dados.set(c.chave, c.valor ?? "");
    }
    this.sessoes.set(c.cliente, { seq: c.seq, resultado });
    return resultado;
  }

  resultadoDe(cliente: string, seq: number): boolean | undefined {
    const s = this.sessoes.get(cliente);
    return s && s.seq === seq ? s.resultado : undefined;
  }
}
