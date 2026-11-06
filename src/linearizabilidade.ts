/**
 * Verificador de linearizabilidade para um registrador (algoritmo de Wing e Gong,
 * com memoização no estilo do Porcupine).
 *
 * Procura uma ordem total das operações que respeite o tempo real e a semântica
 * do registrador. Uma operação sem resposta (cliente desistiu) pode ter acontecido
 * em qualquer momento depois do início, ou nunca: por isso `fim` é Infinity e ela
 * não precisa entrar na ordem.
 */
export interface Operacao {
  id: number;
  inicio: number;
  fim: number;
  tipo: "escrita" | "leitura" | "cas";
  valor?: string;
  esperado?: string | null;
  /** Valor lido, ou sucesso do cas. */
  saida?: string | null | boolean;
}

function aplicar(estado: string | null, op: Operacao): { ok: boolean; estado: string | null } {
  if (op.tipo === "escrita") return { ok: true, estado: op.valor ?? null };
  if (op.tipo === "leitura") return { ok: op.saida === estado, estado };
  const casou = estado === (op.esperado ?? null);
  if (op.fim !== Infinity && op.saida !== casou) return { ok: false, estado };
  return { ok: true, estado: casou ? (op.valor ?? null) : estado };
}

export function linearizavel(historico: Operacao[], limite = 150_000): boolean | "indeterminado" {
  const ops = [...historico].sort((a, b) => a.inicio - b.inicio);
  const n = ops.length;
  const obrigatorias = ops.reduce((t, o) => t + (o.fim !== Infinity ? 1 : 0), 0);
  const vistos = new Set<string>();
  const feito = new Array<boolean>(n).fill(false);
  let passos = 0;

  const buscar = (estado: string | null, feitasObrigatorias: number): boolean | "indeterminado" => {
    if (feitasObrigatorias === obrigatorias) return true;
    if (++passos > limite) return "indeterminado";
    const chave = `${feito.map((f) => (f ? 1 : 0)).join("")}|${estado}`;
    if (vistos.has(chave)) return false;
    vistos.add(chave);

    // Só pode ser a próxima quem começou antes do fim mais cedo entre as pendentes.
    let menorFim = Infinity;
    for (let i = 0; i < n; i++) if (!feito[i] && ops[i]!.fim < menorFim) menorFim = ops[i]!.fim;

    for (let i = 0; i < n; i++) {
      const op = ops[i]!;
      if (feito[i]) continue;
      if (op.inicio > menorFim) break;
      const r = aplicar(estado, op);
      if (!r.ok) continue;
      feito[i] = true;
      const res = buscar(r.estado, feitasObrigatorias + (op.fim !== Infinity ? 1 : 0));
      feito[i] = false;
      if (res !== false) return res;
    }
    return false;
  };
  return buscar(null, 0);
}
