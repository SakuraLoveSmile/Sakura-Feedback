"""Seed only a marked local orb preview DB; never calls AI or external services.

python3 examples/fixtures/seed_orb_demo.py --data-dir <local preview data directory>
The directory must contain .orb-preview-local with this task ID. Existing demo
records are preserved so rerunning does not reset user replies or read state.
"""
import argparse
import datetime as dt
import hashlib
import http.cookiejar
import json
from pathlib import Path
import sqlite3
import urllib.error
import urllib.request

TASK = 'FB-20261101-ORB-VIDEO-01'
BASE = 'http://127.0.0.1:53947'
APP_ID = 'com.example.orb-liquid'
USER = 'orb-demo'
PASSWORD = 'orb-demo-local-20261102'  # Deliberately public local fixture credential.
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data-dir', type=Path, required=True)
args = parser.parse_args()
data = args.data_dir.resolve()
if (data / '.orb-preview-local').read_text().strip() != TASK:
    raise SystemExit('Not a marked orb preview directory')
db = data / 'feedback.db'
if not db.is_file():
    raise SystemExit('Start the isolated preview server first')
conn = sqlite3.connect(db)
conn.execute('PRAGMA foreign_keys=ON')
app = conn.execute('SELECT id FROM apps WHERE app_id=? AND deleted_at IS NULL', (APP_ID,)).fetchone()
if not app:
    raise SystemExit('Expected orb preview app missing')
backup = data.parent / 'r5-before-demo-seed.db'
if not backup.exists():
    dest = sqlite3.connect(backup)
    conn.backup(dest)
    dest.close()
jar = http.cookiejar.CookieJar()
http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def post(path, body):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(),
        {'Content-Type': 'application/json', 'Origin': BASE})
    with http.open(req, timeout=5) as response:
        return json.load(response)
if not conn.execute('SELECT id FROM users WHERE username=?', (USER,)).fetchone():
    post('/api/auth/login', {'username': 'admin', 'password': 'orb-local-admin-20261101'})
    post('/api/admin/users', {'username': USER, 'password': PASSWORD, 'dailyLimit': 50})
user_id = conn.execute('SELECT id FROM users WHERE username=?', (USER,)).fetchone()[0]
admin_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
now = dt.datetime.now(dt.timezone.utc)
def time(hours):
    return (now - dt.timedelta(hours=hours)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
rows = [
    ('capture', '截图时希望多保留一点上下文', '把灵感球拖到文字附近后，希望截图能同时包含标题和正文，方便说明问题。', 'open', 1,
        [], True),
    ('gesture', '三指上滑后，球体能更明显一些吗？', '在深色页面使用三指上滑时，想更快找到刚唤醒的灵感球。', 'waiting_user', 4,
        [('admin', '已收到，正在检查深色页面的对比度。方便补充一下手机型号和使用的主题吗？')], True),
    ('keyboard', '键盘打开时，提交按钮被遮住', '输入较长的反馈描述时，底部提交按钮有时不容易找到。希望键盘弹出后仍能直接提交。', 'waiting_admin', 23,
        [('admin', '我们正在排查。请问是否只在横屏或大字体模式下出现？'), ('user', '我用的是竖屏和系统默认字体，Mi 10，已补充复现步骤。')], False),
    ('attachment', '截图附件预览可以更紧凑', '希望截图附件不要占满半个面板，能留更多空间写下感受。', 'resolved', 48,
        [('admin', '已完成优化：截图改为紧凑卡片，编辑和删除操作保留在右侧。欢迎继续体验。')], False),
]
image = Path(__file__).with_name('orb-demo.png').read_bytes()
image_hash = hashlib.sha256(image).hexdigest()
with conn:
    for slug, title, text, state, age, messages, unread in rows:
        fid = 'orb-demo-r5-' + slug
        if conn.execute('SELECT id FROM feedbacks WHERE id=?', (fid,)).fetchone():
            continue
        created, updated = time(age + 2), time(age)
        conn.execute("INSERT INTO feedbacks\n            (id,app_row_id,app_id,user_id,text,idempotency_key,content_hash,status,title,\n             issue_status,dialogue_version,last_activity_at,created_at,updated_at,resume_paused)\n            VALUES (?,?,?,?,?,?,?,'needs_info',?,?,?,?,?,?,1)",
            (fid, app[0], APP_ID, user_id, text, fid, hashlib.sha256(text.encode()).hexdigest(),
             title, state, len(messages), updated, created, updated))
        for seq, (sender, message) in enumerate(messages, 1):
            note = '截图卡片已改为紧凑横向布局。' if state == 'resolved' else None
            conn.execute('INSERT INTO feedback_messages\n                (id,feedback_id,seq,sender_type,sender_id,sender_name,text,resolution_note,created_at)\n                VALUES (?,?,?,?,?,?,?,?,?)',
                (fid + '-m' + str(seq), fid, seq, sender,
                 admin_id if sender == 'admin' else user_id,
                 '体验支持' if sender == 'admin' else '我', message, note,
                 time(age + (len(messages) - seq) * .25)))
        if not unread and messages:
            conn.execute('INSERT INTO feedback_read_cursors(user_id,feedback_id,last_read_seq,updated_at) VALUES(?,?,?,?)',
                (user_id, fid, len(messages), updated))
        if slug in ('capture', 'gesture', 'attachment'):
            conn.execute("INSERT INTO feedback_images\n                (id,feedback_id,sort,mime,filename,byte_size,sha256,bytes,width,height,source,created_at)\n                VALUES(?,?,0,'image/png','示例截图.png',?,?,?,?,?,'manual',?)",
                (fid + '-image', fid, len(image), image_hash, image, 640, 360, created))
print(json.dumps({'fixtureUser': USER, 'records': [
    {'id': r[0], 'title': r[1], 'state': r[2]} for r in conn.execute(
    "SELECT id,title,issue_status FROM feedbacks WHERE id LIKE 'orb-demo-r5-%' ORDER BY last_activity_at DESC")
]}, ensure_ascii=False, indent=2))
conn.close()
