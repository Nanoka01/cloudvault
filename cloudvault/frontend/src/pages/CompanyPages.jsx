// บริษัท: สร้าง/เข้าร่วม, หน้าบริษัท (งาน + สมาชิก/Monitoring), หน้ารายละเอียดงาน
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, startDownload } from '../api.js';
import { useAuth } from '../auth.jsx';
import { SubmitWorkModal } from '../components/FileModals.jsx';
import { Badge, Empty, FileIcon, Icon, Modal, Spinner, copyText, useAction, useUi } from '../components/ui.jsx';
import { SUBMISSION_STATUS, formatBytes, formatDate, formatDateTime } from '../utils.js';

const StatusBadge = ({ status }) => {
  const s = SUBMISSION_STATUS[status];
  return s ? <Badge tone={s.tone}>{s.label}</Badge> : <Badge>ยังไม่ส่ง</Badge>;
};

// ---------- สร้าง / เข้าร่วม ----------
export function CompaniesPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [run, busy] = useAction();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const create = (e) => {
    e.preventDefault();
    run(async () => {
      const { company } = await api('POST', '/companies', { name });
      await refresh();
      navigate(`/companies/${company.companyId}`);
    }, 'สร้างบริษัทแล้ว');
  };
  const join = (e) => {
    e.preventDefault();
    run(async () => {
      const { company } = await api('POST', '/companies/join', { inviteCode: code });
      await refresh();
      navigate(`/companies/${company.companyId}`);
    }, 'เข้าร่วมบริษัทแล้ว');
  };

  return (
    <>
      <div className="page-head"><div><h1>บริษัท</h1><p className="muted">สร้างบริษัทของคุณเอง หรือเข้าร่วมด้วยรหัสเชิญจากหัวหน้า</p></div></div>
      <div className="grid-2">
        <form className="card pad form" onSubmit={create}>
          <h2><Icon name="building" /> สร้างบริษัทใหม่</h2>
          <p className="muted">คุณจะเป็นเจ้าของ (แอดมิน) ได้รหัสเชิญไว้ส่งให้ลูกทีม สั่งงานและตรวจงานได้</p>
          <label className="field"><span>ชื่อบริษัท</span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="เช่น บริษัท คลาวด์ จำกัด" /></label>
          <button className="btn btn-primary" disabled={busy}>สร้างบริษัท</button>
        </form>
        <form className="card pad form" onSubmit={join}>
          <h2><Icon name="users" /> เข้าร่วมด้วยรหัสเชิญ</h2>
          <p className="muted">ขอรหัสจากเจ้าของบริษัท รูปแบบ CV-XXXXXX</p>
          <label className="field"><span>รหัสเชิญ</span><input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required placeholder="CV-7K2QX9" className="mono" /></label>
          <button className="btn btn-primary" disabled={busy}>เข้าร่วม</button>
        </form>
      </div>
    </>
  );
}

// ---------- หน้าบริษัท ----------
export function CompanyPage() {
  const { companyId } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const { toast, confirm } = useUi();
  const [run, busy] = useAction();
  const [company, setCompany] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [members, setMembers] = useState(null);
  const [tab, setTab] = useState('tasks');
  const [showCreate, setShowCreate] = useState(false);
  const isOwner = company?.role === 'OWNER';

  const load = useCallback(
    () =>
      run(async () => {
        const [{ company: c }, t] = await Promise.all([
          api('GET', `/companies/${companyId}`),
          api('GET', `/companies/${companyId}/tasks`),
        ]);
        setCompany(c);
        setTasks(t.tasks);
        if (c.role === 'OWNER') setMembers(await api('GET', `/companies/${companyId}/members`));
      }),
    [run, companyId],
  );
  useEffect(() => {
    setCompany(null); setTasks(null); setMembers(null); setTab('tasks');
    load();
  }, [load]);

  const rotate = async () => {
    if (!(await confirm({ title: 'เปลี่ยนรหัสเชิญ?', message: 'รหัสเดิมจะใช้ไม่ได้ทันที สมาชิกเดิมยังอยู่ครบ', confirmText: 'เปลี่ยนรหัส' }))) return;
    run(async () => {
      const { inviteCode } = await api('POST', `/companies/${companyId}/invite-code/rotate`);
      setCompany((c) => ({ ...c, inviteCode }));
    }, 'เปลี่ยนรหัสเชิญแล้ว');
  };

  const removeMember = async (m) => {
    if (!(await confirm({ title: `นำ ${m.name} ออกจากบริษัท?`, message: 'งานที่ยังรอตรวจของคนนี้จะถูกยกเลิกและปลดล็อกไฟล์คืนให้เขา', confirmText: 'นำออก', danger: true }))) return;
    run(async () => { await api('DELETE', `/companies/${companyId}/members/${m.userId}`); await load(); }, 'นำสมาชิกออกแล้ว');
  };

  const leave = async () => {
    if (!(await confirm({ title: 'ออกจากบริษัท?', message: 'งานที่ยังรอตรวจจะถูกยกเลิกและไฟล์จะถูกปลดล็อก', confirmText: 'ออกจากบริษัท', danger: true }))) return;
    const me = await api('GET', '/me');
    run(async () => {
      await api('DELETE', `/companies/${companyId}/members/${me.user.userId}`);
      await refresh();
      navigate('/');
    }, 'ออกจากบริษัทแล้ว');
  };

  if (!company) return <Spinner />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{company.name}</h1>
          <p className="muted">{isOwner ? 'คุณเป็นเจ้าของบริษัท' : 'คุณเป็นสมาชิก'}</p>
        </div>
        {isOwner ? (
          <div className="invite-box">
            <span className="muted small">รหัสเชิญ</span>
            <code className="invite-code" data-testid="invite-code">{company.inviteCode}</code>
            <button className="icon-btn" title="คัดลอก" onClick={async () => toast((await copyText(company.inviteCode)) ? 'คัดลอกรหัสแล้ว' : 'คัดลอกไม่สำเร็จ')}><Icon name="copy" /></button>
            <button className="icon-btn" title="เปลี่ยนรหัสเชิญ" onClick={rotate} disabled={busy}><Icon name="refresh" /></button>
          </div>
        ) : (
          <button className="btn btn-danger-ghost" onClick={leave}>ออกจากบริษัท</button>
        )}
      </div>

      {isOwner && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}><Icon name="task" size={16} />งาน</button>
          <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}><Icon name="users" size={16} />สมาชิก & พื้นที่</button>
        </div>
      )}

      {tab === 'tasks' && (
        <div className="card">
          <div className="card-head">
            <h2>{isOwner ? 'งานทั้งหมด' : 'งานที่ได้รับมอบหมาย'}</h2>
            {isOwner && <button className="btn btn-primary btn-sm" onClick={() => setShowCreate(true)}><Icon name="plus" size={16} />สร้างงาน</button>}
          </div>
          {!tasks ? <div className="pad"><Spinner /></div> : tasks.length === 0 ? (
            <Empty icon="task" title={isOwner ? 'ยังไม่มีงาน' : 'ยังไม่มีงานที่มอบหมายให้คุณ'}>
              {isOwner && (members?.members.length > 1 ? 'กด “สร้างงาน” เพื่อสั่งงานลูกทีม' : 'ส่งรหัสเชิญให้ลูกทีมเข้าร่วมก่อน แล้วค่อยสร้างงาน')}
            </Empty>
          ) : (
            <ul className="task-list">
              {tasks.map((t) => (
                <li key={t.taskId}>
                  <Link to={`/companies/${companyId}/tasks/${t.taskId}`}>
                    <div className="grow min0">
                      <div className="task-title truncate">{t.title}</div>
                      <div className="muted small">
                        {t.dueDate ? `กำหนดส่ง ${formatDate(t.dueDate)}` : 'ไม่มีกำหนดส่ง'} · ผู้รับผิดชอบ {t.assignees.length} คน
                      </div>
                    </div>
                    {isOwner ? (
                      <div className="task-stats">
                        {t.pendingCount > 0 && <Badge tone="warn">รอตรวจ {t.pendingCount}</Badge>}
                        <Badge tone="good">ผ่าน {t.approvedCount}/{t.assignees.length}</Badge>
                      </div>
                    ) : <StatusBadge status={t.myStatus} />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'members' && members && (
        <div className="card">
          <div className="card-head">
            <h2>สมาชิก & พื้นที่ที่ใช้</h2>
            <span className="muted small">พื้นที่บริษัท (งานที่ Approve): <strong>{formatBytes(members.companyUsedBytes)}</strong></span>
          </div>
          <table className="table">
            <thead><tr><th>สมาชิก</th><th>พื้นที่ส่วนตัวที่ใช้</th><th className="hide-sm">เข้าร่วมเมื่อ</th><th /></tr></thead>
            <tbody>
              {members.members.map((m) => {
                const pct = m.quotaBytes ? (m.usedBytes / m.quotaBytes) * 100 : 0;
                return (
                  <tr key={m.userId}>
                    <td>
                      <div className="file-cell">
                        <span className="avatar sm">{m.name[0]?.toUpperCase()}</span>
                        <div className="min0"><div className="truncate">{m.name} {m.role === 'OWNER' && <Badge>เจ้าของ</Badge>}</div><div className="muted small truncate">{m.email}</div></div>
                      </div>
                    </td>
                    <td className="usage-cell">
                      <div className="row-between small"><span>{formatBytes(m.usedBytes)}</span><span className="muted">{Math.round(pct)}%</span></div>
                      <div className="meter"><div className={`meter-fill ${pct > 90 ? 'bad' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                    </td>
                    <td className="hide-sm muted">{formatDate(m.joinedAt)}</td>
                    <td className="actions">
                      {m.role !== 'OWNER' && <button className="btn btn-sm btn-danger-ghost" onClick={() => removeMember(m)}>นำออก</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateTaskModal
          companyId={companyId}
          members={members?.members.filter((m) => m.role === 'MEMBER') || []}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </>
  );
}

function CreateTaskModal({ companyId, members, onClose, onCreated }) {
  const [run, busy] = useAction();
  const [form, setForm] = useState({ title: '', description: '', dueDate: '', assignees: new Set(members.map((m) => m.userId)) });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id) => {
    const next = new Set(form.assignees);
    next.has(id) ? next.delete(id) : next.add(id);
    set('assignees', next);
  };
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('POST', `/companies/${companyId}/tasks`, {
        title: form.title, description: form.description, dueDate: form.dueDate || null, assignees: [...form.assignees],
      });
      onCreated();
    }, 'สร้างงานแล้ว');
  };
  return (
    <Modal title="สร้างงานใหม่" onClose={onClose} width={560}>
      {members.length === 0 ? (
        <Empty icon="users" title="ยังไม่มีสมาชิก">ส่งรหัสเชิญให้ลูกทีมเข้าร่วมก่อน แล้วค่อยสร้างงาน</Empty>
      ) : (
        <form className="form" onSubmit={submit}>
          <label className="field"><span>หัวข้องาน</span><input value={form.title} onChange={(e) => set('title', e.target.value)} required maxLength={150} /></label>
          <label className="field"><span>รายละเอียด</span><textarea rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} /></label>
          <label className="field"><span>กำหนดส่ง (ไม่บังคับ)</span><input type="date" value={form.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></label>
          <fieldset className="field">
            <span>ผู้รับผิดชอบ</span>
            <div className="check-list">
              {members.map((m) => (
                <label key={m.userId}><input type="checkbox" checked={form.assignees.has(m.userId)} onChange={() => toggle(m.userId)} />{m.name} <span className="muted small">{m.email}</span></label>
              ))}
            </div>
          </fieldset>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={busy || !form.assignees.size}>สร้างงาน</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ---------- รายละเอียดงาน ----------
export function TaskPage() {
  const { companyId, taskId } = useParams();
  const [data, setData] = useState(null);
  const [run, busy] = useAction();
  const { toast } = useUi();
  const [showSubmit, setShowSubmit] = useState(false);
  const [review, setReview] = useState(null); // {submission, action}
  const base = `/companies/${companyId}/tasks/${taskId}`;

  const load = useCallback(() => run(async () => setData(await api('GET', base))), [run, base]);
  useEffect(() => { load(); }, [load]);

  const download = (sub, file) =>
    run(async () => {
      try {
        startDownload((await api('GET', `${base}/submissions/${sub.submissionId}/files/${file.fileId}/download-url`)).url);
      } catch (err) {
        if (err.code !== 'ARCHIVED') throw err;
        setArchived((a) => ({ ...a, [file.fileId]: err.body.restoring ? 'restoring' : 'archived' }));
        toast(err.message, 'warn');
      }
    });
  const [archived, setArchived] = useState({});
  const requestRestore = (sub, file) =>
    run(async () => {
      await api('POST', `${base}/submissions/${sub.submissionId}/files/${file.fileId}/restore`);
      setArchived((a) => ({ ...a, [file.fileId]: 'restoring' }));
    }, 'ส่งคำขอกู้คืนแล้ว ใช้เวลาประมาณ 12–48 ชั่วโมง');

  if (!data) return <Spinner />;
  const { task, role, submissions, assignees } = data;
  const isOwner = role === 'OWNER';
  const hasPending = submissions.some((s) => s.status === 'PENDING');
  const latestByUser = Object.fromEntries([...submissions].reverse().map((s) => [s.userId, s.status]));

  return (
    <>
      <p className="crumb"><Link to={`/companies/${companyId}`}>← กลับไปหน้าบริษัท</Link></p>
      <div className="page-head">
        <div>
          <h1>{task.title}</h1>
          <p className="muted">{task.dueDate ? `กำหนดส่ง ${formatDate(task.dueDate)}` : 'ไม่มีกำหนดส่ง'} · สร้างเมื่อ {formatDate(task.createdAt)}</p>
        </div>
        {!isOwner && (
          <button className="btn btn-primary" onClick={() => setShowSubmit(true)} disabled={hasPending}
            title={hasPending ? 'มีงานที่รอตรวจอยู่แล้ว' : ''}>
            <Icon name="send" size={16} /> {hasPending ? 'รอแอดมินตรวจ' : 'ส่งงาน'}
          </button>
        )}
      </div>

      {task.description && <div className="card pad description">{task.description}</div>}

      {isOwner && (
        <div className="card">
          <div className="card-head"><h2>ผู้รับผิดชอบ</h2></div>
          <ul className="assignee-list">
            {assignees.map((a) => (
              <li key={a.userId}><span className="avatar sm">{a.name[0]?.toUpperCase()}</span><span className="grow">{a.name}</span><StatusBadge status={latestByUser[a.userId]} /></li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>{isOwner ? 'งานที่ส่งเข้ามา' : 'ประวัติการส่งงานของคุณ'}</h2></div>
        {submissions.length === 0 ? (
          <Empty icon="send" title="ยังไม่มีการส่งงาน" />
        ) : (
          <ul className="submission-list">
            {submissions.map((s) => (
              <li key={s.submissionId} className={`submission status-${s.status.toLowerCase()}`}>
                <div className="row-between">
                  <div>
                    {isOwner && <strong>{s.userName} </strong>}
                    <span className="muted small">ส่งเมื่อ {formatDateTime(s.createdAt)}</span>
                    {s.late && <Badge tone="bad">ส่งช้า</Badge>}
                  </div>
                  <StatusBadge status={s.status} />
                </div>
                {s.note && <p className="note">“{s.note}”</p>}
                <ul className="sub-files">
                  {s.files.map((f) => (
                    <li key={f.fileId}>
                      <FileIcon name={f.name} />
                      <span className="grow truncate">{f.name}</span>
                      <span className="muted small">{formatBytes(f.size)}</span>
                      {(s.status === 'PENDING' || s.status === 'APPROVED') && (
                        archived[f.fileId] && isOwner ? (
                          archived[f.fileId] === 'restoring'
                            ? <Badge tone="warn" icon="archive">กำลังกู้คืน</Badge>
                            : <button className="btn btn-sm" onClick={() => requestRestore(s, f)} disabled={busy}><Icon name="archive" size={14} />ขอกู้คืน</button>
                        ) : (
                          <button className="icon-btn" title="ดาวน์โหลด" onClick={() => download(s, f)} disabled={busy}><Icon name="download" /></button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
                {s.comment && <p className="comment"><strong>ความเห็นแอดมิน:</strong> {s.comment}</p>}
                {isOwner && s.status === 'PENDING' && (
                  <div className="review-actions">
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => setReview({ submission: s, action: 'reject' })}>ส่งกลับแก้ไข</button>
                    <button className="btn btn-sm btn-success" onClick={() => setReview({ submission: s, action: 'approve' })}><Icon name="check" size={14} />Approve</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showSubmit && (
        <SubmitWorkModal task={task} companyId={companyId} onClose={() => setShowSubmit(false)}
          onSubmitted={() => { setShowSubmit(false); load(); }} />
      )}
      {review && (
        <ReviewModal base={base} {...review} onClose={() => setReview(null)} onDone={() => { setReview(null); load(); }} />
      )}
    </>
  );
}

function ReviewModal({ base, submission, action, onClose, onDone }) {
  const [comment, setComment] = useState('');
  const [run, busy] = useAction();
  const approve = action === 'approve';
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('PATCH', `${base}/submissions/${submission.submissionId}`, { action, comment });
      onDone();
    }, approve ? 'Approve แล้ว ไฟล์ย้ายไปพื้นที่บริษัท' : 'ส่งกลับให้แก้ไขแล้ว');
  };
  const total = submission.files.reduce((s, f) => s + f.size, 0);
  return (
    <Modal title={approve ? `Approve งานของ ${submission.userName}` : `ส่งกลับให้ ${submission.userName} แก้ไข`} onClose={onClose} width={500}>
      <form className="form" onSubmit={submit}>
        {approve ? (
          <p className="hint">ไฟล์ {submission.files.length} ไฟล์ ({formatBytes(total)}) จะย้ายไปพื้นที่บริษัท ผู้ส่งได้พื้นที่คืน หลัง 3 วันไฟล์จะถูกลดระดับเป็น Glacier Instant Retrieval อัตโนมัติเพื่อประหยัดค่าใช้จ่าย</p>
        ) : (
          <p className="hint">ไฟล์จะถูกปลดล็อกคืนให้ผู้ส่ง แก้ไขแล้วส่งใหม่ได้</p>
        )}
        <label className="field">
          <span>ความเห็น {approve ? '(ไม่บังคับ)' : ''}</span>
          <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} required={!approve} maxLength={2000} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>ยกเลิก</button>
          <button className={`btn ${approve ? 'btn-success' : 'btn-danger'}`} disabled={busy}>{approve ? 'Approve' : 'ส่งกลับแก้ไข'}</button>
        </div>
      </form>
    </Modal>
  );
}
