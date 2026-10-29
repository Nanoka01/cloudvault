// My Files, ถังขยะ, งานที่ส่งแล้ว
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, startDownload } from '../api.js';
import { useAuth } from '../auth.jsx';
import { ShareModal, UploadModal, VersionsModal } from '../components/FileModals.jsx';
import { Badge, Empty, FileIcon, Icon, Modal, Spinner, useAction, useUi } from '../components/ui.jsx';
import { daysLeftInTrash, formatBytes, formatDate, typeLabel } from '../utils.js';

function useFiles(view) {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const [files, setFiles] = useState(null);
  const [run] = useAction();
  const load = useCallback(
    () => run(async () => setFiles((await api('GET', `/files?view=${view}&q=${encodeURIComponent(q)}`)).files)),
    [run, view, q],
  );
  useEffect(() => { load(); }, [load]);
  return { files, load, q };
}

// ---------- My Files ----------
export function MyFilesPage() {
  const { files, load, q } = useFiles('active');
  const { refresh } = useAuth();
  const { confirm } = useUi();
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null); // {type, file}

  const download = (f) => run(async () => startDownload((await api('GET', `/files/${f.fileId}/download-url`)).url));
  const remove = async (f) => {
    if (!(await confirm({ title: 'ย้ายไปถังขยะ?', message: `“${f.name}” จะอยู่ในถังขยะ 30 วันก่อนถูกลบถาวร`, confirmText: 'ย้ายไปถังขยะ', danger: true }))) return;
    await run(async () => { await api('DELETE', `/files/${f.fileId}`); await load(); await refresh(); }, 'ย้ายไปถังขยะแล้ว');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Files</h1>
          <p className="muted">ไฟล์ส่วนตัวของคุณ เลือกส่งให้บริษัทได้จากหน้างาน</p>
        </div>
        <button className="btn btn-primary" onClick={() => setModal({ type: 'upload' })}>
          <Icon name="upload" size={16} /> อัปโหลดไฟล์
        </button>
      </div>

      <div className="card">
        {!files ? <div className="pad"><Spinner /></div> : files.length === 0 ? (
          <Empty title={q ? `ไม่พบไฟล์ที่ชื่อมี “${q}”` : 'ยังไม่มีไฟล์'}>
            {!q && 'กด “อัปโหลดไฟล์” หรือลากไฟล์มาวางเพื่อเริ่มต้น'}
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr><th>ชื่อไฟล์</th><th className="hide-sm">ประเภท</th><th>ขนาด</th><th className="hide-sm">แก้ไขล่าสุด</th><th className="right">จัดการ</th></tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const locked = f.status === 'LOCKED';
                return (
                  <tr key={f.fileId} className={locked ? 'row-locked' : ''}>
                    <td>
                      <div className="file-cell">
                        <FileIcon name={f.name} />
                        <div className="min0">
                          <div className="truncate">{f.name}</div>
                          {locked && (
                            <Badge tone="warn" icon="lock">
                              รอตรวจ · <Link to={`/companies/${f.companyId}/tasks/${f.taskId}`}>{f.taskTitle}</Link>
                            </Badge>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="hide-sm muted">{typeLabel(f.name)}</td>
                    <td className="muted">{formatBytes(f.size)}</td>
                    <td className="hide-sm muted">{formatDate(f.updatedAt)}</td>
                    <td className="actions">
                      <button className="icon-btn" title="ดาวน์โหลด" onClick={() => download(f)} disabled={busy}><Icon name="download" /></button>
                      <button className="icon-btn" title={locked ? 'ไฟล์ถูกล็อก' : 'แชร์ลิงก์'} disabled={locked} onClick={() => setModal({ type: 'share', file: f })}><Icon name="share" /></button>
                      <button className="icon-btn" title="ประวัติเวอร์ชัน" onClick={() => setModal({ type: 'versions', file: f })}><Icon name="history" /></button>
                      <button className="icon-btn" title={locked ? 'ไฟล์ถูกล็อก' : 'อัปโหลดเวอร์ชันใหม่'} disabled={locked} onClick={() => setModal({ type: 'replace', file: f })}><Icon name="upload" /></button>
                      <button className="icon-btn" title={locked ? 'ไฟล์ถูกล็อก' : 'เปลี่ยนชื่อ'} disabled={locked} onClick={() => setModal({ type: 'rename', file: f })}><Icon name="edit" /></button>
                      <button className="icon-btn danger" title={locked ? 'ไฟล์ถูกล็อก' : 'ลบ'} disabled={locked} onClick={() => remove(f)}><Icon name="trash" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {modal?.type === 'upload' && <UploadModal onClose={() => setModal(null)} onUploaded={load} />}
      {modal?.type === 'replace' && <UploadModal replaceFile={modal.file} onClose={() => setModal(null)} onUploaded={load} />}
      {modal?.type === 'share' && <ShareModal file={modal.file} onClose={() => setModal(null)} />}
      {modal?.type === 'versions' && <VersionsModal file={modal.file} onClose={() => setModal(null)} onChanged={load} />}
      {modal?.type === 'rename' && <RenameModal file={modal.file} onClose={() => setModal(null)} onDone={load} />}
    </>
  );
}

function RenameModal({ file, onClose, onDone }) {
  const [name, setName] = useState(file.name);
  const [run, busy] = useAction();
  const save = (e) => {
    e.preventDefault();
    run(async () => { await api('PATCH', `/files/${file.fileId}`, { name }); onDone(); onClose(); }, 'เปลี่ยนชื่อแล้ว');
  };
  return (
    <Modal title="เปลี่ยนชื่อไฟล์" onClose={onClose} width={440}>
      <form onSubmit={save} className="form">
        <label className="field"><span>ชื่อไฟล์</span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-primary" disabled={busy}>บันทึก</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- ถังขยะ ----------
export function TrashPage() {
  const { files, load, q } = useFiles('trash');
  const { refresh } = useAuth();
  const { confirm } = useUi();
  const [run, busy] = useAction();

  const restore = (f) => run(async () => { await api('POST', `/files/${f.fileId}/restore`); await load(); }, 'กู้คืนไฟล์แล้ว');
  const purge = async (f) => {
    if (!(await confirm({ title: 'ลบถาวร?', message: `“${f.name}” และทุกเวอร์ชันจะถูกลบจาก S3 และกู้คืนไม่ได้อีก`, confirmText: 'ลบถาวร', danger: true }))) return;
    await run(async () => { await api('DELETE', `/files/${f.fileId}/permanent`); await load(); await refresh(); }, 'ลบถาวรแล้ว');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ถังขยะ</h1>
          <p className="muted">ไฟล์ในถังขยะจะถูกลบถาวรอัตโนมัติหลัง 30 วัน และยังนับพื้นที่อยู่</p>
        </div>
      </div>
      <div className="card">
        {!files ? <div className="pad"><Spinner /></div> : files.length === 0 ? (
          <Empty icon="trash" title={q ? `ไม่พบไฟล์ที่ชื่อมี “${q}”` : 'ถังขยะว่าง'} />
        ) : (
          <table className="table">
            <thead><tr><th>ชื่อไฟล์</th><th className="hide-sm">วันที่ลบ</th><th>ขนาด</th><th className="right">จัดการ</th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.fileId}>
                  <td><div className="file-cell"><FileIcon name={f.name} /><span className="truncate">{f.name}</span></div></td>
                  <td className="hide-sm muted">{formatDate(f.deletedAt)} <span className="small">· เหลือ {daysLeftInTrash(f.deletedAt)} วัน</span></td>
                  <td className="muted">{formatBytes(f.size)}</td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => restore(f)} disabled={busy}><Icon name="restore" size={14} />กู้คืน</button>
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => purge(f)} disabled={busy}><Icon name="trash" size={14} />ลบถาวร</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ---------- งานที่ส่งแล้ว (ไฟล์ที่ Approve แล้ว ย้ายไปพื้นที่บริษัท) ----------
export function SubmittedPage() {
  const { files, load, q } = useFiles('submitted');
  const { refresh } = useAuth();
  const { confirm, toast } = useUi();
  const [run, busy] = useAction();

  const download = (f) =>
    run(async () => {
      try {
        startDownload((await api('GET', `/files/${f.fileId}/download-url`)).url);
      } catch (err) {
        if (err.code === 'ARCHIVED') toast(err.message, 'warn');
        else throw err;
      }
    });
  const copyBack = (f) => run(async () => { await api('POST', `/files/${f.fileId}/copy-to-drive`); await refresh(); }, 'ทำสำเนาไว้ใน My Files แล้ว');
  const hide = async (f) => {
    if (!(await confirm({ title: 'ซ่อนรายการนี้?', message: 'ไฟล์ของบริษัทไม่ถูกลบ แค่ไม่แสดงในรายการของคุณ', confirmText: 'ซ่อน' }))) return;
    await run(async () => { await api('DELETE', `/files/${f.fileId}`); await load(); }, 'ซ่อนรายการแล้ว');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>งานที่ส่งแล้ว</h1>
          <p className="muted">ไฟล์ที่แอดมิน Approve แล้วถูกย้ายไปพื้นที่บริษัท ไม่นับพื้นที่ของคุณ ดูและดาวน์โหลดได้อย่างเดียว</p>
        </div>
      </div>
      <div className="card">
        {!files ? <div className="pad"><Spinner /></div> : files.length === 0 ? (
          <Empty icon="send" title={q ? `ไม่พบไฟล์ที่ชื่อมี “${q}”` : 'ยังไม่มีงานที่ผ่านการตรวจ'} />
        ) : (
          <table className="table">
            <thead><tr><th>ชื่อไฟล์</th><th className="hide-sm">งาน / บริษัท</th><th>ขนาด</th><th className="hide-sm">Approve เมื่อ</th><th className="right">จัดการ</th></tr></thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.fileId}>
                  <td><div className="file-cell"><FileIcon name={f.name} /><span className="truncate">{f.name}</span></div></td>
                  <td className="hide-sm"><div className="truncate">{f.taskTitle}</div><div className="muted small">{f.companyName}</div></td>
                  <td className="muted">{formatBytes(f.size)}</td>
                  <td className="hide-sm muted">{formatDate(f.approvedAt)}</td>
                  <td className="actions">
                    <button className="icon-btn" title="ดาวน์โหลด" onClick={() => download(f)} disabled={busy}><Icon name="download" /></button>
                    <button className="icon-btn" title="ทำสำเนากลับมา My Files" onClick={() => copyBack(f)} disabled={busy}><Icon name="copy" /></button>
                    <button className="icon-btn" title="ซ่อนจากรายการ" onClick={() => hide(f)} disabled={busy}><Icon name="eye" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
