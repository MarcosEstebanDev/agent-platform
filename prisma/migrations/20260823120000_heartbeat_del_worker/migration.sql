-- Fase 1b: latido del worker y barrido de corridas abandonadas.
-- Ver docs/specs/002-ejecucion-asincrona.md

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN "heartbeat_at" TIMESTAMP(3);

-- Las corridas que ya existian nunca latieron. Se les pone el inicio como
-- ultimo latido: si siguen abiertas, el reaper las va a cerrar en el primer
-- barrido, que es exactamente lo correcto -- ningun worker las esta corriendo.
UPDATE "agent_runs" SET "heartbeat_at" = "started_at" WHERE "finished_at" IS NULL;

-- CreateIndex
CREATE INDEX "agent_runs_finished_at_heartbeat_at_idx" ON "agent_runs"("finished_at", "heartbeat_at");
