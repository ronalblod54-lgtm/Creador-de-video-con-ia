import os, sqlite3, secrets, hashlib, hmac, uuid, subprocess, threading, json, re, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from contextlib import contextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT=Path(__file__).resolve().parent.parent
DATA=Path(os.getenv('CLIP_DATA',ROOT/'data')); DATA.mkdir(parents=True,exist_ok=True)
MEDIA=DATA/'media'; MEDIA.mkdir(exist_ok=True)
DB=DATA/'clips.sqlite3'
WEB=ROOT/'web'
app=FastAPI(title='Creador de Clips IA',version='0.1.0')

def conn():
 c=sqlite3.connect(DB,timeout=30); c.row_factory=sqlite3.Row; c.execute('PRAGMA foreign_keys=ON'); return c

def init():
 with conn() as c:
  c.executescript('''CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',blocked INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,source TEXT NOT NULL,filename TEXT NOT NULL,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clips(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),account_id TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,hashtags TEXT NOT NULL,start REAL NOT NULL,end REAL NOT NULL,score INTEGER NOT NULL DEFAULT 0,used INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',progress INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',output TEXT NOT NULL DEFAULT '',created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS live_events(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),url TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created TEXT NOT NULL);''')
init()

def now():return datetime.now(timezone.utc).isoformat()
def digest(password,salt):return hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(salt),120000).hex()
def bearer(authorization:str|None=Header(default=None)):
 token=(authorization or '').removeprefix('Bearer ').strip()
 if not token:raise HTTPException(401,'Inicia sesión')
 with conn() as c:
  row=c.execute('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires>?',(hashlib.sha256(token.encode()).hexdigest(),now())).fetchone()
 if not row or row['blocked']:raise HTTPException(401,'Sesión inválida o cuenta bloqueada')
 return dict(row)
def admin(user=Depends(bearer)):
 if user['role']!='admin':raise HTTPException(403,'Solo administrador')
 return user
class Credentials(BaseModel):
 username:str=Field(min_length=3,max_length=60)
 password:str=Field(min_length=6,max_length=200)
class ClipInput(BaseModel):
 start:float=Field(ge=0); end:float=Field(gt=0); title:str=Field(min_length=1,max_length=200); hashtags:str=''
class ClipPatch(BaseModel):
 title:str|None=None; hashtags:str|None=None; used:bool|None=None
class LiveInput(BaseModel):url:str

def token_for(user):
 token=secrets.token_urlsafe(32)
 with conn() as c:c.execute('INSERT INTO sessions VALUES (?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),user['id'],(datetime.now(timezone.utc)+timedelta(days=30)).isoformat()))
 return {'token':token,'username':user['username'],'role':user['role']}
@app.post('/api/register')
def register(payload:Credentials):
 name=payload.username.strip().lower()
 if not re.fullmatch(r'[a-z0-9_.-]{3,60}',name):raise HTTPException(400,'Usuario: letras, números, _, . o -')
 salt=secrets.token_hex(16); uid=uuid.uuid4().hex
 try:
  with conn() as c:
   count=c.execute('SELECT COUNT(*) FROM accounts').fetchone()[0]
   c.execute('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)',(uid,name,digest(payload.password,salt),salt,'admin' if count==0 else 'member',0,now()))
 except sqlite3.IntegrityError:raise HTTPException(409,'Usuario existente')
 return token_for({'id':uid,'username':name,'role':'admin' if count==0 else 'member'})
@app.post('/api/login')
def login(payload:Credentials):
 with conn() as c:row=c.execute('SELECT * FROM accounts WHERE username=?',(payload.username.strip().lower(),)).fetchone()
 if not row or not hmac.compare_digest(row['password_hash'],digest(payload.password,row['salt'])) or row['blocked']:raise HTTPException(401,'Credenciales incorrectas o cuenta bloqueada')
 return token_for(row)
@app.post('/api/logout')
def logout(authorization:str|None=Header(default=None),user=Depends(bearer)):
 token=(authorization or '').removeprefix('Bearer ').strip()
 with conn() as c:c.execute('DELETE FROM sessions WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),))
 return {'ok':True}
@app.get('/api/me')
def me(user=Depends(bearer)):return {'username':user['username'],'role':user['role']}
@app.post('/api/projects')
async def upload(title:str=Form('Mi video'),file:UploadFile=File(...),user=Depends(bearer)):
 ext=Path(file.filename or '').suffix.lower()
 if ext not in ('.mp4','.mov','.mkv','.webm'):raise HTTPException(400,'Usa MP4, MOV, MKV o WEBM')
 pid=uuid.uuid4().hex; path=MEDIA/f'{pid}{ext}'; size=0
 try:
  with path.open('wb') as out:
   while chunk:=await file.read(1024*1024):
    size+=len(chunk)
    if size>1024*1024*1024:raise HTTPException(413,'Máximo 1 GB')
    out.write(chunk)
 except Exception:
  path.unlink(missing_ok=True);raise
 with conn() as c:c.execute('INSERT INTO projects VALUES (?,?,?,?,?,?)',(pid,user['id'],title[:200],file.filename or 'archivo',str(path),now()))
 return {'id':pid,'title':title}
@app.get('/api/projects')
def projects(user=Depends(bearer)):
 with conn() as c:return [dict(r) for r in c.execute('SELECT id,title,source,created FROM projects WHERE account_id=? ORDER BY created DESC',(user['id'],))]
@app.delete('/api/projects/{pid}')
def delete_project(pid:str,user=Depends(bearer)):
 with conn() as c:
  p=c.execute('SELECT * FROM projects WHERE id=? AND account_id=?',(pid,user['id'])).fetchone()
  if not p:raise HTTPException(404,'Proyecto no encontrado')
  clips=c.execute('SELECT output FROM clips WHERE project_id=?',(pid,)).fetchall()
  c.execute('DELETE FROM clips WHERE project_id=?',(pid,));c.execute('DELETE FROM projects WHERE id=?',(pid,))
 Path(p['filename']).unlink(missing_ok=True)
 for r in clips:
  if r['output']:Path(r['output']).unlink(missing_ok=True)
 return {'ok':True}

def render(cid):
 with conn() as c:
  clip=c.execute('SELECT * FROM clips WHERE id=?',(cid,)).fetchone()
  project=c.execute('SELECT * FROM projects WHERE id=?',(clip['project_id'],)).fetchone()
 output=MEDIA/f'{cid}.mp4'
 with conn() as c:c.execute("UPDATE clips SET status='processing',progress=10 WHERE id=?",(cid,))
 # Scale to fill 9:16 while keeping source aspect ratio; centered crop.
 cmd=['ffmpeg','-nostdin','-y','-ss',str(clip['start']),'-i',project['filename'],'-t',str(clip['end']-clip['start']),'-vf','scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1','-c:v','libx264','-preset','medium','-crf','18','-c:a','aac','-b:a','192k','-movflags','+faststart',str(output)]
 try:
  p=subprocess.run(cmd,capture_output=True,text=True,timeout=1800)
  if p.returncode:raise RuntimeError(p.stderr[-700:])
  with conn() as c:c.execute("UPDATE clips SET status='ready',progress=100,output=? WHERE id=?",(str(output),cid))
 except Exception as e:
  output.unlink(missing_ok=True)
  with conn() as c:c.execute("UPDATE clips SET status='error',error=? WHERE id=?",(str(e)[:700],cid))
@app.post('/api/projects/{pid}/clips')
def create_clip(pid:str,payload:ClipInput,user=Depends(bearer)):
 with conn() as c:p=c.execute('SELECT * FROM projects WHERE id=? AND account_id=?',(pid,user['id'])).fetchone()
 if not p:raise HTTPException(404,'Proyecto no encontrado')
 if payload.end<=payload.start or payload.end-payload.start>180:raise HTTPException(400,'Duración entre 0 y 180 segundos')
 cid=uuid.uuid4().hex
 with conn() as c:c.execute('INSERT INTO clips(id,project_id,account_id,title,hashtags,start,end,created) VALUES (?,?,?,?,?,?,?,?)',(cid,pid,user['id'],payload.title,payload.hashtags,payload.start,payload.end,now()))
 threading.Thread(target=render,args=(cid,),daemon=True).start()
 return {'id':cid,'status':'queued'}
@app.get('/api/clips')
def clips(user=Depends(bearer)):
 with conn() as c:return [dict(r) for r in c.execute('SELECT id,project_id,title,hashtags,start,end,score,used,status,progress,error,created FROM clips WHERE account_id=? ORDER BY created DESC',(user['id'],))]
@app.patch('/api/clips/{cid}')
def patch_clip(cid:str,payload:ClipPatch,user=Depends(bearer)):
 updates=payload.model_dump(exclude_unset=True)
 if not updates:return {'ok':True}
 with conn() as c:
  if not c.execute('SELECT 1 FROM clips WHERE id=? AND account_id=?',(cid,user['id'])).fetchone():raise HTTPException(404,'Clip no encontrado')
  c.execute('UPDATE clips SET '+','.join(f'{k}=?' for k in updates)+' WHERE id=?',(*[int(v) if isinstance(v,bool) else v for v in updates.values()],cid))
 return {'ok':True}
@app.delete('/api/clips/{cid}')
def delete_clip(cid:str,user=Depends(bearer)):
 with conn() as c:
  r=c.execute('SELECT output FROM clips WHERE id=? AND account_id=?',(cid,user['id'])).fetchone()
  if not r:raise HTTPException(404,'Clip no encontrado')
  c.execute('DELETE FROM clips WHERE id=?',(cid,))
 if r['output']:Path(r['output']).unlink(missing_ok=True)
 return {'ok':True}
@app.get('/api/clips/{cid}/download')
def download(cid:str,user=Depends(bearer)):
 with conn() as c:r=c.execute('SELECT * FROM clips WHERE id=? AND account_id=?',(cid,user['id'])).fetchone()
 if not r or r['status']!='ready' or not Path(r['output']).exists():raise HTTPException(404,'Clip no disponible')
 return FileResponse(r['output'],media_type='video/mp4',filename='clip-'+cid[:8]+'.mp4')
@app.post('/api/live')
def add_live(payload:LiveInput,user=Depends(bearer)):
 if not payload.url.startswith('https://'):raise HTTPException(400,'Usa una URL HTTPS')
 lid=uuid.uuid4().hex
 with conn() as c:c.execute('INSERT INTO live_events VALUES (?,?,?,?,?)',(lid,user['id'],payload.url,'pending',now()))
 return {'id':lid,'status':'pending','message':'Enlace guardado. Monitor automático pendiente de integración.'}
@app.get('/api/live')
def live(user=Depends(bearer)):
 with conn() as c:return [dict(r) for r in c.execute('SELECT * FROM live_events WHERE account_id=? ORDER BY created DESC',(user['id'],))]
@app.get('/api/admin/accounts')
def accounts(user=Depends(admin)):
 with conn() as c:return [dict(r) for r in c.execute('SELECT id,username,role,blocked,created FROM accounts ORDER BY created DESC')]
@app.post('/api/admin/accounts/{uid}/block')
def block(uid:str,blocked:bool,user=Depends(admin)):
 if uid==user['id']:raise HTTPException(400,'No puedes bloquearte')
 with conn() as c:
  c.execute('UPDATE accounts SET blocked=? WHERE id=?',(int(blocked),uid))
  if blocked:c.execute('DELETE FROM sessions WHERE account_id=?',(uid,))
 return {'ok':True}
@app.get('/api/health')
def health():return {'ok':True,'ffmpeg':subprocess.run(['ffmpeg','-version'],capture_output=True).returncode==0}
app.mount('/',StaticFiles(directory=WEB,html=True),name='web')
