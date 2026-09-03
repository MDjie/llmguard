DROP INDEX IF EXISTS "evaluation_results_scope_run_case_uq";

CREATE UNIQUE INDEX IF NOT EXISTS "evaluation_results_scope_run_case_attempt_uq"
  ON "evaluation_results" (
    "tenant_id", "application_id", "run_id", "test_case_id", "attempt"
  );

CREATE OR REPLACE FUNCTION reject_evaluation_result_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evaluation results are immutable; append a new attempt';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evaluation_results_immutable_update ON "evaluation_results";
CREATE TRIGGER evaluation_results_immutable_update
BEFORE UPDATE ON "evaluation_results"
FOR EACH ROW EXECUTE FUNCTION reject_evaluation_result_mutation();
