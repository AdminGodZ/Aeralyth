"""Verify lease release can pass an uncommitted tree publication fence."""
import os
import subprocess
import time
import uuid
CMD = [os.environ.get("PSQL", "psql"), os.environ["DATABASE_URL"], "-XqAt", "-v", "ON_ERROR_STOP=1"]
x='bookkeep_review_'+uuid.uuid4().hex[:8]; owner=x+'_owner'; other=x+'_other'; parent=x+'_parent'; upload=x+'_upload'
def run(sql):
 r=subprocess.run(CMD,input=sql,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout
def send(p,s):p.stdin.write(s+'\n');p.stdin.flush()
def marker(p,s):
 while True:
  line=p.stdout.readline()
  if not line:raise RuntimeError(p.stderr.read())
  if line.strip()==s:return
run(f"INSERT INTO users(id,username,password_hash,role,status) VALUES('{owner}','{owner}','none','user','active'),('{other}','{other}','none','user','active'); INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES('{parent}','{owner}','root','{parent}',0,'folder'); INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,size_bytes,reservation_bytes,upload_mode,status,completion_lease_token,expires_at) VALUES('{upload}','{x}_file','{owner}','{parent}','reserved','{x}_object',3,3,'single','completing','lease',now()+interval '1 hour');")
p=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
 send(p,f"BEGIN; INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('{owner}','{parent}','trash'); \\echo UNCOMMITTED_FENCE")
 marker(p,'UNCOMMITTED_FENCE')
 before=time.monotonic()
 run(f"SET statement_timeout='1s'; UPDATE file_uploads SET completion_available_at=now()+interval '1second',completion_locked_until=NULL,completion_lease_token=NULL,completion_last_error='waiting' WHERE id='{upload}';")
 print('Bookkeeping lease release completed despite uncommitted exclusive owner publication:',round((time.monotonic()-before)*1000,2),'ms')
 send(p,'COMMIT;')
 p.communicate(timeout=5)
 for assignment in [f"owner_id='{other}'",'reservation_bytes=4',"status='pending'","object_key='unexpected'",'parent_id=NULL','completion_attempts=1','completion_dead_lettered_at=now()']:
  expected = "'P0001'" if assignment.startswith(('owner_id=', 'reservation_bytes=')) else "'55000'"
  sql=f"DO $$ BEGIN BEGIN UPDATE file_uploads SET {assignment} WHERE id='{upload}'; RAISE EXCEPTION 'unexpected mutation accepted'; EXCEPTION WHEN SQLSTATE {expected} THEN NULL; END; END $$;"
  run(sql)
  print('Rejected fenced mutation:',assignment)
 print(run(f"SELECT status,reservation_bytes,completion_attempts,completion_lease_token IS NULL FROM file_uploads WHERE id='{upload}';"))
finally:
 if p.poll() is None:p.kill();p.communicate()
 run(f"DELETE FROM users WHERE id IN ('{owner}','{other}');")
