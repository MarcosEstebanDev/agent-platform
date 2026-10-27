-- Fases 2 y 3: el ticket termina en un PR, y DONE lo deciden los checks.
--
-- ADD VALUE no se puede usar en la misma transaccion que lo agrega, pero aca
-- nadie lo usa: solo se declara.

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE 'PR_OPEN';
ALTER TYPE "TicketStatus" ADD VALUE 'CHECKS_RUNNING';
ALTER TYPE "TicketStatus" ADD VALUE 'CHECKS_PASSED';
ALTER TYPE "TicketStatus" ADD VALUE 'CHANGES_REQUESTED';

-- AlterTable
ALTER TABLE "tickets" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "pr_number" INTEGER,
ADD COLUMN     "pr_url" TEXT,
ADD COLUMN     "gate_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "gate_feedback" TEXT,
ADD COLUMN     "checks_started_at" TIMESTAMP(3),
ADD COLUMN     "status_reason" TEXT;

-- CreateIndex
CREATE INDEX "tickets_pr_number_idx" ON "tickets"("pr_number");
