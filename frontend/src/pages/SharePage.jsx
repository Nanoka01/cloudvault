// หน้าดาวน์โหลดไฟล์ที่ถูกแชร์ (/s/:token) เปิดได้โดยไม่ต้องมีบัญชี
// แสดงชื่อไฟล์ คนแชร์ ขนาด และเวลาที่ลิงก์ยังใช้ได้ ก่อนกดดาวน์โหลด
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { shareDownloadUrl, tokenFromSharePath } from '../api.js';
import { Brand, FileIcon, Icon, Spinner, Stamp } from '../components/ui.jsx';
import { formatBytes, formatDate, formatDateTime, typeLabel } from '../utils.js';

const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:3001').replace(/\/$/, '');

function timeLeft(expiresAt, now) {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(min, 1)} นาที`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} ชั่วโมง`;
  return `${Math.floor(hours / 24)} วัน`;
}

export default function SharePage() {
  const { token: raw } = useParams();
  const token = tokenFromSharePath(raw || '');
  const [state, setState] = useState({ status: 'loading' });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/share/${token}/info`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (res.ok) setState({ status: 'ready', file: body });
        else setState({ status: res.status === 410 ? 'expired' : 'gone', message: body.message });
      })
      .catch(() => alive && setState({ status: 'offline' }));
    return () => { alive = false; };
  }, [token]);

  // นับเวลาที่เหลือใหม่ทุกนาที
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.title = state.file ? `${state.file.name} | CloudVault` : 'ไฟล์ที่แชร์กับคุณ | CloudVault';
  }, [state.file]);

  const left = state.file ? timeLeft(state.file.expiresAt, now) : null;
  const expired = state.status === 'expired' || (state.status === 'ready' && !left);

  return (
    <div className="share-page">
      <Brand to="/" />

      {state.status === 'loading' && <div className="center-screen" style={{ minHeight: 280 }}><Spinner /></div>}

      {state.status === 'ready' && (
        <article className={`ticket ${expired ? 'void' : ''}`} aria-label={`ไฟล์ ${state.file.name}`}>
          <div className="ticket-main">
            <FileIcon name={state.file.name} />
            <div className="min0">
              <h1 className="ticket-name">{state.file.name}</h1>
              <p className="ticket-from"><Icon name="user" size={14} /> {state.file.sharedBy} แชร์ไฟล์นี้ให้คุณ</p>
            </div>
            <dl className="ticket-facts">
              <div><dt>ประเภท</dt><dd>{typeLabel(state.file.name)}</dd></div>
              <div><dt>ขนาด</dt><dd>{formatBytes(state.file.size)}</dd></div>
              <div><dt>แก้ไขล่าสุด</dt><dd>{formatDate(state.file.updatedAt)}</dd></div>
            </dl>
          </div>
          <div className="ticket-stub">
            {expired ? (
              <p className="ticket-note">ลิงก์นี้หมดอายุแล้ว ขอลิงก์ใหม่จาก {state.file.sharedBy}</p>
            ) : (
              <>
                <a className="btn btn-primary btn-block" href={shareDownloadUrl(token)} data-testid="share-download">
                  <Icon name="download" size={18} /> ดาวน์โหลด {formatBytes(state.file.size)}
                </a>
                <p className="ticket-note">
                  <Icon name="clock" size={13} /> ลิงก์ใช้ได้อีก {left} (ถึง {formatDateTime(state.file.expiresAt)})
                </p>
              </>
            )}
          </div>
          {expired && <Stamp tone="bad">หมดอายุ</Stamp>}
        </article>
      )}

      {(state.status === 'expired' || state.status === 'gone' || state.status === 'offline') && (
        <article className="ticket void" aria-live="polite">
          <div className="ticket-main">
            <FileIcon name="file" />
            <div className="min0">
              <h1 className="ticket-name">
                {state.status === 'expired' ? 'ลิงก์นี้หมดอายุแล้ว' : state.status === 'gone' ? 'ไม่พบไฟล์นี้แล้ว' : 'เชื่อมต่อไม่ได้'}
              </h1>
              <p className="ticket-from">
                {state.status === 'expired' && 'ลิงก์แชร์มีอายุจำกัด ขอลิงก์ใหม่จากคนที่ส่งให้คุณ'}
                {state.status === 'gone' && 'เจ้าของลบหรือย้ายไฟล์ไปแล้ว ติดต่อคนที่ส่งลิงก์ให้คุณ'}
                {state.status === 'offline' && 'ตรวจสอบอินเทอร์เน็ตแล้วโหลดหน้านี้ใหม่'}
              </p>
            </div>
          </div>
          <div className="ticket-stub">
            <button className="btn btn-block" onClick={() => window.location.reload()}><Icon name="refresh" size={16} /> โหลดหน้านี้ใหม่</button>
          </div>
          <Stamp tone="bad">{state.status === 'offline' ? 'ออฟไลน์' : 'ใช้ไม่ได้'}</Stamp>
        </article>
      )}
    </div>
  );
}
