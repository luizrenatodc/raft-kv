import assert from "node:assert/strict";
import { test } from "node:test";
import { Kv } from "../src/kv.ts";
import { linearizavel, type Operacao } from "../src/linearizabilidade.ts";
import { simular, type Cenario } from "../src/simulador.ts";

const SEMENTES = Number(process.env.SEMENTES ?? 60);

function varrer(base: Omit<Cenario, "semente">, sementes = SEMENTES, pararNaPrimeira = false) {
  let violacoes = 0;
  let naoLinearizaveis = 0;
  let indeterminados = 0;
  let primeira: number | null = null;
  for (let semente = 1; semente <= sementes; semente++) {
    const r = simular({ ...base, semente });
    let falhou = r.violacoes.length > 0;
    violacoes += r.violacoes.length;
    for (const h of r.historicos.values()) {
      const v = linearizavel(h);
      if (v === "indeterminado") indeterminados++;
      if (v === false) {
        naoLinearizaveis++;
        falhou = true;
      }
    }
    if (falhou && primeira === null) primeira = semente;
    if (falhou && pararNaPrimeira) break;
  }
  return { violacoes, naoLinearizaveis, indeterminados, primeira };
}

test("mantém as invariantes e a linearizabilidade sob quedas, perdas e partições", () => {
  const r = varrer({});
  assert.deepEqual({ v: r.violacoes, l: r.naoLinearizaveis, i: r.indeterminados, primeira: r.primeira }, { v: 0, l: 0, i: 0, primeira: null });
});

test("continua seguro em rede muito hostil", () => {
  const r = varrer({ perda: 0.3, atrasoMax: 25, chanceQueda: 0.01, chanceParticao: 0.01 }, 30);
  assert.equal(r.violacoes + r.naoLinearizaveis, 0);
});

test("a mesma semente reproduz exatamente a mesma execução", () => {
  const a = simular({ semente: 7 });
  const b = simular({ semente: 7 });
  assert.deepEqual(a.metricas, b.metricas);
  assert.deepEqual([...a.historicos], [...b.historicos]);
});

test("progride: sem falhas, elege um único líder e conclui operações", () => {
  const r = simular({ semente: 3, perda: 0, chanceQueda: 0, chanceParticao: 0 });
  assert.equal(r.metricas.eleicoes, 1);
  assert.ok(r.metricas.concluidas > 100, `concluídas: ${r.metricas.concluidas}`);
  assert.equal(r.metricas.desistencias, 0);
});

test("volta a progredir depois das falhas", () => {
  for (const semente of [1, 2, 3, 4, 5]) {
    const r = simular({ semente, chanceQueda: 0.005 });
    assert.ok(r.metricas.concluidas > 20, `semente ${semente}: ${r.metricas.concluidas}`);
  }
});

// Testes dos testes: cada defeito remove uma regra e a suíte precisa acusar.
const HOSTIL = { chanceQueda: 0.01, chanceParticao: 0.01, perda: 0.1 };

test("detecta nó que esquece o voto depois de cair", () => {
  const r = varrer({ nos: 3, perda: 0.02, atrasoMax: 12, chanceQueda: 0.08, chanceVolta: 0.6, chanceParticao: 0, defeitos: { esquecerVoto: true } }, 400, true);
  assert.ok(r.violacoes + r.naoLinearizaveis > 0);
});

test("detecta eleição que ignora a atualização do log", () => {
  const r = varrer({ ...HOSTIL, defeitos: { ignorarLogNoVoto: true } }, 300, true);
  assert.ok(r.violacoes + r.naoLinearizaveis > 0);
});

test("detecta leitura servida sem confirmar a liderança", () => {
  const r = varrer({ ...HOSTIL, defeitos: { leituraSemConfirmar: true } }, 300, true);
  assert.ok(r.naoLinearizaveis > 0);
});

test("verificador aceita histórico válido com operações concorrentes", () => {
  const h: Operacao[] = [
    { id: 1, inicio: 0, fim: 10, tipo: "escrita", valor: "x" },
    { id: 2, inicio: 1, fim: 5, tipo: "leitura", saida: "x" },
    { id: 3, inicio: 6, fim: 8, tipo: "leitura", saida: "x" },
  ];
  assert.equal(linearizavel(h), true);
});

test("verificador rejeita leitura velha depois de leitura nova", () => {
  const h: Operacao[] = [
    { id: 1, inicio: 0, fim: 2, tipo: "escrita", valor: "x" },
    { id: 2, inicio: 3, fim: 20, tipo: "escrita", valor: "y" },
    { id: 3, inicio: 4, fim: 5, tipo: "leitura", saida: "y" },
    { id: 4, inicio: 6, fim: 7, tipo: "leitura", saida: "x" },
  ];
  assert.equal(linearizavel(h), false);
});

test("verificador trata escrita sem resposta como talvez aplicada", () => {
  const talvez: Operacao = { id: 1, inicio: 0, fim: Infinity, tipo: "escrita", valor: "x" };
  assert.equal(linearizavel([talvez, { id: 2, inicio: 5, fim: 6, tipo: "leitura", saida: "x" }]), true);
  assert.equal(linearizavel([talvez, { id: 2, inicio: 5, fim: 6, tipo: "leitura", saida: null }]), true);
});

test("sessões impedem aplicação dupla de um comando repetido", () => {
  const kv = new Kv();
  const c = { cliente: "c", seq: 1, tipo: "cas" as const, chave: "k", valor: "1", esperado: null };
  assert.equal(kv.aplicar(c), true);
  assert.equal(kv.aplicar(c), true, "repetição devolve o resultado guardado");
  assert.equal(kv.aplicar({ ...c, seq: 2 }), false);
  assert.equal(kv.dados.get("k"), "1");
});
