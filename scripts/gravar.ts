// Grava uma execução real do simulador para o painel de replay.
import { writeFileSync } from "node:fs";
import { simular } from "../src/simulador.ts";

const semente = 12;
const r = simular({ semente, duracao: 1400, chanceQueda: 0.006, chanceParticao: 0.005, gravar: true });
writeFileSync("docs/execucao.js", `window.EXECUCAO=${JSON.stringify({ semente, metricas: r.metricas, quadros: r.quadros })};\n`);
console.log(r.quadros.length, "quadros", JSON.stringify(r.metricas));
console.log(r.quadros.map((q, i) => (q.evento ? `${i}:${q.evento}` : "")).filter(Boolean).slice(0, 14).join(" | "));
