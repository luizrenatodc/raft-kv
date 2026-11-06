// Roda a campanha de sementes e imprime os números usados no README.
import { linearizavel } from "../src/linearizabilidade.ts";
import { simular, type Cenario } from "../src/simulador.ts";

function campanha(nome: string, base: Omit<Cenario, "semente">, sementes: number, parar = false) {
  const t0 = performance.now();
  const soma = { execucoes: 0, ops: 0, quedas: 0, particoes: 0, eleicoes: 0, mensagens: 0, perdidas: 0, violacoes: 0, naoLinear: 0, indeterminados: 0 };
  let primeira: number | null = null;
  for (let semente = 1; semente <= sementes; semente++) {
    const r = simular({ ...base, semente });
    soma.execucoes++;
    soma.quedas += r.metricas.quedas;
    soma.particoes += r.metricas.particoes;
    soma.eleicoes += r.metricas.eleicoes;
    soma.mensagens += r.metricas.mensagens;
    soma.perdidas += r.metricas.perdidas;
    soma.violacoes += r.violacoes.length;
    let falhou = r.violacoes.length > 0;
    for (const h of r.historicos.values()) {
      soma.ops += h.length;
      const v = linearizavel(h);
      if (v === false) {
        soma.naoLinear++;
        falhou = true;
      }
      if (v === "indeterminado") soma.indeterminados++;
    }
    if (falhou && primeira === null) primeira = semente;
    if (falhou && parar) break;
  }
  console.log(JSON.stringify({ nome, primeira, ms: Math.round(performance.now() - t0), ...soma }));
}

const hostil = { chanceQueda: 0.01, chanceParticao: 0.01, perda: 0.1 };
campanha("padrão", {}, 500);
campanha("hostil", { perda: 0.3, atrasoMax: 25, chanceQueda: 0.01, chanceParticao: 0.01 }, 200);
campanha("defeito: esquece o voto", { nos: 3, perda: 0.02, atrasoMax: 12, chanceQueda: 0.08, chanceVolta: 0.6, chanceParticao: 0, defeitos: { esquecerVoto: true } }, 400, true);
campanha("defeito: voto ignora log", { ...hostil, defeitos: { ignorarLogNoVoto: true } }, 300, true);
campanha("defeito: leitura sem quórum", { ...hostil, defeitos: { leituraSemConfirmar: true } }, 300, true);
campanha("defeito: commit de termo antigo", { ...hostil, defeitos: { commitDeTermoAntigo: true } }, 300, true);
