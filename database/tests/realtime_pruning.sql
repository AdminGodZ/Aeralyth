\set ON_ERROR_STOP on
BEGIN;
TRUNCATE realtime_events;
UPDATE realtime_stream_state SET head=0,floor=0 WHERE singleton;
INSERT INTO realtime_events(user_id,scope,folder_ids,created_at)
SELECT 'prune_test','files',ARRAY['folder'],now()-interval '25 hours' FROM generate_series(1,50000);
UPDATE realtime_stream_state SET head=(SELECT max(id) FROM realtime_events) WHERE singleton;
DO $$
DECLARE before_count BIGINT; removed BIGINT := 0; pass_count INTEGER; passes INTEGER:=0; started TIMESTAMPTZ:=clock_timestamp(); saved_head BIGINT;
BEGIN
 SELECT head INTO saved_head FROM realtime_stream_state WHERE singleton;
 LOOP
  SELECT realtime_prune() INTO pass_count;
  removed:=removed+pass_count;
  passes:=passes+1;
  IF pass_count<2048 THEN EXIT; END IF;
 END LOOP;
 IF removed<>50000 OR EXISTS(SELECT 1 FROM realtime_events) THEN RAISE EXCEPTION 'expired backlog did not drain'; END IF;
 IF (SELECT floor FROM realtime_stream_state WHERE singleton)<>saved_head THEN RAISE EXCEPTION 'pruning failed to advance reset floor'; END IF;
 RAISE NOTICE 'Drained % expired events in % bounded batches, elapsed %; replay floor reached head %',removed,passes,clock_timestamp()-started,saved_head;
END $$;
INSERT INTO realtime_events(user_id,scope,folder_ids) VALUES('prune_test','files',ARRAY['new-folder']);
UPDATE realtime_stream_state SET head=(SELECT max(id) FROM realtime_events) WHERE singleton;
DO $$ BEGIN
 IF (SELECT realtime_prune())<>0 THEN RAISE EXCEPTION 'fresh event pruned'; END IF;
 IF (SELECT head<=floor FROM realtime_stream_state WHERE singleton) THEN RAISE EXCEPTION 'post-prune fresh replay cannot progress'; END IF;
END $$;
-- A steady eligible-row workload above the old 273 rows/second ceiling.
-- Each bounded pass drains before the next burst; no cumulative eight-batch
-- allowance applies. This is a local PostgreSQL service-capacity probe.
DO $$
DECLARE step INTEGER; batch INTEGER; deadline TIMESTAMPTZ; started TIMESTAMPTZ:=clock_timestamp();
BEGIN
 FOR step IN 1..40 LOOP
  INSERT INTO realtime_events(user_id,scope,folder_ids,created_at)
  SELECT 'prune_test','files',ARRAY['folder'],now()-interval '25 hours' FROM generate_series(1,1000);
  UPDATE realtime_stream_state SET head=(SELECT max(id) FROM realtime_events) WHERE singleton;
  deadline:=clock_timestamp()+interval '250 milliseconds';
  LOOP
   SELECT realtime_prune() INTO batch;
   EXIT WHEN batch<2048 OR clock_timestamp()>=deadline;
  END LOOP;
  IF EXISTS(SELECT 1 FROM realtime_events WHERE created_at<now()-interval '24 hours') THEN
   RAISE EXCEPTION 'expired backlog grew at supported local input rate';
  END IF;
  PERFORM pg_sleep(0.05);
 END LOOP;
 RAISE NOTICE 'Sustained 40000 eligible writes with zero expired backlog after each bounded pass; elapsed %, observed rate % rows/sec',
  clock_timestamp()-started,40000/EXTRACT(EPOCH FROM clock_timestamp()-started);
END $$;

ROLLBACK;
