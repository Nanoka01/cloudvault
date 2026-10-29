// Modal ที่เกี่ยวกับไฟล์: อัปโหลด, แชร์ลิงก์, ประวัติเวอร์ชัน, เลือกไฟล์เพื่อส่งงาน
import { useEffect, useRef, useState } from 'react';
import { api, sharePageUrl, startDownload, uploadFile } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ACCEPT, extOf, formatBytes, formatDate, formatDateTime } from '../utils.js';
import { Badge, Empty, FileIcon, Icon, Modal, Spinner, copyText, useAction, useUi } from './ui.jsx';

// อัปโหลด (ลากวาง / เลือกไฟล์ หลายไฟล์พร้อมกัน)
export function UploadModal({ onClose, onUploaded, replaceFile }) {
  const { refresh } = useAuth();
  const { toast } = useUi();
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const running = items.some((i) => i.state === 'uploading');
  // อัปโหลดเวอร์ชันใหม่ได้เฉพาะไฟล์นามสกุลเดียวกับไฟล์เดิม
  const requiredExt = replaceFile ? extOf(replaceFile.name) : null;

  const update = (id, patch) => setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const start = async (fileList) => {
    const files = [...fileList].slice(0, replaceFile ? 1 : 20);
    if (requiredExt && files.some((f) => extOf(f.name) !== requiredExt)) {
      toast(`เวอร์ชันใหม่ต้องเป็นไฟล์ .${requiredExt} เหมือนเดิม ถ้าเป็นไฟล์คนละประเภทให้อัปโหลดเป็นไฟล์ใหม่`, 'bad');
      return;
    }
    const queued = files.map((file) => ({ id: crypto.randomUUID(), file, progress: 0, state: 'uploading' }));
    setItems((prev) => [...prev, ...queued]);
    const done = [];
    for (const item of queued) {
      try {
        const res = await uploadFile(item.file, {
          fileId: replaceFile?.fileId,
          onProgress: (p) => update(item.id, { progress: p }),
        });
        update(item.id, { state: 'done', progress: 1 });
        done.push(res.file);
      } catch (err) {
        update(item.id, { state: 'error', error: err.message });
      }
    }
    await refresh();
    if (done.length) {
      toast(replaceFile ? 'อัปโหลดเวอร์ชันใหม่แล้ว' : `อัปโหลดสำเร็จ ${done.length} ไฟล์`);
      onUploaded?.(done);
    }
  };

  return (
    <Modal
      title={replaceFile ? `อัปโหลดเวอร์ชันใหม่: ${replaceFile.name}` : 'อัปโหลดไฟล์'}
      onClose={() => !running && onClose()}
      footer={<button className="btn" onClick={onClose} disabled={running}>{running ? 'กำลังอัปโหลด…' : 'ปิด'}</button>}
    >
      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); start(e.dataTransfer.files); }}
      >
        <Icon name="upload" size={40} />
        <p><strong>ลากไฟล์มาวางที่นี่</strong></p>
        <p className="muted">หรือ</p>
        <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>เลือกไฟล์</button>
        <input ref={inputRef} type="file" hidden multiple={!replaceFile} accept={requiredExt ? `.${requiredExt}` : ACCEPT}
          onChange={(e) => { start(e.target.files); e.target.value = ''; }} data-testid="file-input" />
        <p className="muted small">
          {requiredExt
            ? `เลือกไฟล์ .${requiredExt} เท่านั้น ไฟล์เดิมจะเก็บไว้ในประวัติเวอร์ชัน`
            : 'PDF, Word, Excel, PowerPoint, CSV, TXT, ZIP, JPG, PNG, MP4 ได้สูงสุดไฟล์ละ 5 GB'}
        </p>
      </div>
      {items.length > 0 && (
        <ul className="upload-list">
          {items.map((i) => (
            <li key={i.id}>
              <FileIcon name={i.file.name} />
              <div className="grow">
                <div className="row-between">
                  <span className="truncate">{i.file.name}</span>
                  <span className="muted small">{formatBytes(i.file.size)}</span>
                </div>
                {i.state === 'error' ? (
                  <p className="text-bad small">{i.error}</p>
                ) : (
                  <div className="meter"><div className="meter-fill" style={{ width: `${i.progress * 100}%` }} /></div>
                )}
              </div>
              {i.state === 'done' && <Icon name="check" className="text-good" />}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// แชร์ลิงก์
export function ShareModal({ file, onClose }) {
  const { toast } = useUi();
  const [run, busy] = useAction();
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState(null);

  // ลิงก์ชี้ไปหน้าดาวน์โหลดของเว็บนี้ (/s/...) ไม่ใช่ API ตรงๆ คนรับเห็นชื่อไฟล์ ขนาด และวันหมดอายุก่อนกดโหลด
  const create = () =>
    run(async () => {
      const res = await api('POST', `/files/${file.fileId}/share`, { hours: Number(hours) });
      setLink({ ...res, pageUrl: sharePageUrl(res.token) });
    });

  return (
    <Modal title={`แชร์ “${file.name}”`} onClose={onClose}
      footer={<button className="btn" onClick={onClose}>เสร็จสิ้น</button>}>
      <p className="muted">คนที่ได้ลิงก์จะเห็นหน้าดาวน์โหลดของไฟล์นี้ ไม่ต้องมีบัญชี CloudVault และใช้ได้จนลิงก์หมดอายุ</p>
      <div className="field-row">
        <label className="field grow">
          <span>อายุลิงก์</span>
          <select value={hours} onChange={(e) => { setHours(e.target.value); setLink(null); }}>
            <option value={1}>1 ชั่วโมง</option>
            <option value={24}>1 วัน</option>
            <option value={72}>3 วัน</option>
            <option value={168}>7 วัน</option>
          </select>
        </label>
        <button className="btn btn-primary" onClick={create} disabled={busy}>สร้างลิงก์</button>
      </div>
      {link && (
        <div className="share-link">
          <input readOnly value={link.pageUrl} onFocus={(e) => e.target.select()} aria-label="ลิงก์แชร์" data-testid="share-url" />
          <button className="btn" onClick={async () => toast((await copyText(link.pageUrl)) ? 'คัดลอกลิงก์แล้ว' : 'คัดลอกไม่สำเร็จ')}>
            <Icon name="copy" size={16} /> คัดลอก
          </button>
          <div className="meta">
            <span><Icon name="clock" size={13} />หมดอายุ {formatDateTime(link.expiresAt)}</span>
            <span><a href={link.pageUrl} target="_blank" rel="noreferrer">เปิดดูหน้าดาวน์โหลด</a></span>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ประวัติเวอร์ชัน (S3 Versioning)
export function VersionsModal({ file, onClose, onChanged }) {
  const [versions, setVersions] = useState(null);
  const [run, busy] = useAction();
  const { confirm } = useUi();
  const { refresh } = useAuth();
  const locked = file.status !== 'ACTIVE';

  const load = () => run(async () => setVersions((await api('GET', `/files/${file.fileId}/versions`)).versions));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const download = (v) =>
    run(async () => startDownload((await api('GET', `/files/${file.fileId}/versions/${encodeURIComponent(v.versionId)}/download-url`)).url));

  const restore = async (v) => {
    if (!(await confirm({ title: 'กู้คืนเวอร์ชันนี้?', message: `เวอร์ชันวันที่ ${formatDateTime(v.lastModified)} จะกลายเป็นเวอร์ชันปัจจุบัน เวอร์ชันอื่นยังเก็บไว้ตามเดิม`, confirmText: 'กู้คืน' }))) return;
    await run(async () => {
      await api('POST', `/files/${file.fileId}/versions/${encodeURIComponent(v.versionId)}/restore`);
      await refresh();
      onChanged?.();
      await load();
    }, 'กู้คืนเวอร์ชันแล้ว');
  };

  return (
    <Modal title={`ประวัติเวอร์ชัน: ${file.name}`} onClose={onClose} width={600}
      footer={<button className="btn" onClick={onClose}>ปิด</button>}>
      <p className="muted small">เวอร์ชันเก่าเก็บไว้ 30 วันหลังถูกแทนที่ แล้วลบอัตโนมัติ</p>
      {!versions ? <Spinner /> : (
        <table className="table compact">
          <thead><tr><th>วันที่</th><th>ขนาด</th><th /></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.versionId}>
                <td>{formatDateTime(v.lastModified)} {v.isCurrent && <Badge tone="good">ปัจจุบัน</Badge>}</td>
                <td>{formatBytes(v.size)}</td>
                <td className="actions">
                  <button className="icon-btn" title="ดาวน์โหลด" onClick={() => download(v)} disabled={busy}><Icon name="download" /></button>
                  {!v.isCurrent && !locked && (
                    <button className="btn btn-sm" onClick={() => restore(v)} disabled={busy}>กู้คืน</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

// เลือกไฟล์จาก My Files เพื่อส่งงาน
export function SubmitWorkModal({ task, companyId, onClose, onSubmitted }) {
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [note, setNote] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [run, busy] = useAction();
  const { refresh } = useAuth();

  const load = () => run(async () => setFiles((await api('GET', '/files?view=active')).files));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const submit = () =>
    run(async () => {
      await api('POST', `/companies/${companyId}/tasks/${task.taskId}/submissions`, { fileIds: [...selected], note });
      await refresh();
      onSubmitted();
    }, 'ส่งงานแล้ว ไฟล์จะถูกล็อกจนกว่าหัวหน้าทีมจะตรวจ');

  if (showUpload) {
    return (
      <UploadModal
        onClose={() => { setShowUpload(false); load(); }}
        onUploaded={(done) => setSelected((s) => new Set([...s, ...done.map((f) => f.fileId)]))}
      />
    );
  }

  return (
    <Modal title={`ส่งงาน: ${task.title}`} onClose={onClose} width={620}
      footer={
        <>
          <button className="btn" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !selected.size}>
            ส่งงาน ({selected.size} ไฟล์)
          </button>
        </>
      }>
      <div className="row-between">
        <p className="muted">เลือกไฟล์จาก My Files ของคุณ</p>
        <button className="btn btn-sm" onClick={() => setShowUpload(true)}><Icon name="upload" size={16} />อัปโหลดไฟล์ใหม่</button>
      </div>
      {!files ? <Spinner /> : files.length === 0 ? (
        <Empty title="ยังไม่มีไฟล์ใน My Files">อัปโหลดไฟล์ก่อน แล้วเลือกส่งได้เลย</Empty>
      ) : (
        <ul className="pick-list">
          {files.map((f) => {
            const disabled = f.status !== 'ACTIVE';
            return (
              <li key={f.fileId}>
                <label className={disabled ? 'disabled' : ''}>
                  <input type="checkbox" checked={selected.has(f.fileId)} disabled={disabled} onChange={() => toggle(f.fileId)} />
                  <FileIcon name={f.name} />
                  <span className="grow truncate">{f.name}</span>
                  {disabled ? <Badge tone="warn" icon="lock">ล็อกอยู่</Badge> : <span className="meta"><span>{formatBytes(f.size)}</span><span>{formatDate(f.updatedAt)}</span></span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <label className="field">
        <span>หมายเหตุถึงหัวหน้าทีม (ไม่บังคับ)</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </label>
      <p className="hint"><Icon name="lock" size={14} /> ไฟล์ที่ส่งจะถูกล็อก (ลบ แก้ไข แชร์ไม่ได้) จนกว่าหัวหน้าทีมจะตรวจ ถ้าผ่าน ไฟล์จะย้ายไปพื้นที่ทีมและคืนพื้นที่ให้คุณ</p>
    </Modal>
  );
}
