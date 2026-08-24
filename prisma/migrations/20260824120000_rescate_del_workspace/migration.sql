-- CreateTable
CREATE TABLE "run_artifacts" (
    "run_id" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "skipped" JSONB NOT NULL,
    "file_count" INTEGER NOT NULL,
    "total_bytes" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_artifacts_pkey" PRIMARY KEY ("run_id")
);

-- AddForeignKey
ALTER TABLE "run_artifacts" ADD CONSTRAINT "run_artifacts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

