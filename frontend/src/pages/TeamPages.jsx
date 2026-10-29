// ทีม (1 คน 1 ทีม): สร้าง/เข้าร่วม, หน้าทีม (งาน / ไฟล์ของทีม / สมาชิก), รายละเอียดงาน
import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, startDownload } from '../api.js';
import { useAuth } from '../auth.jsx';
import { SubmitWorkModal } from '../components/FileModals.jsx';
import { Badge, Empty, FileIcon, Icon, Modal, Spinner, Stamp, copyText, useAction, useUi } from '../components/ui.jsx';
import { SUBMISSION_STATUS, formatBytes, formatDate, formatDateTime } from '../utils.js';

// ป้ายสถานะงาน
const StatusBadge = ({ status, fresh }) => {
  const s = SUBMISSION_STATUS[status];
  return s ? <Stamp tone={s.tone} fresh={fresh}>{s.label}</Stamp> : <Stamp>ยังไม่ส่ง</Stamp>;
};

// /team → ยังไม่มีทีม: หน้าสร้าง/เข้าร่วม · มีทีมแล้ว: หน้าทีม
export function TeamHome() {
  const { team } = useAuth();
  return team ? <TeamPage companyId={team.companyId} /> : <NoTeamPage />;
}

// ยังไม่มีทีม
function NoTeamPage() {
  const { refresh } = useAuth();
  const [run, busy] = useAction();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const create = (e) => {
    e.preventDefault();
    run(async () => { await api('POST', '/companies', { name }); await refresh(); }, 'สร้างทีมแล้ว');
  };
  const join = (e) => {
    e.preventDefault();
    run(async () => { await api('POST', '/companies/join', { inviteCode: code }); await refresh(); }, 'เข้าร่วมทีมแล้ว');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ทีม</h1>
          <p className="muted">คุณยังไม่มีทีม ใช้ My Files ได้ตามปกติ หรือสร้าง/เข้าร่วมทีมได้ 1 ทีม</p>
        </div>
      </div>
      <div className="grid-2">
        <form className="card pad form" onSubmit={create}>
          <h2><Icon name="building" /> สร้างทีมใหม่</h2>
          <p className="muted">คุณจะเป็นหัวหน้าทีม ได้รหัสเชิญไว้ส่งให้ลูกทีม สั่งงาน ตรวจงาน และมีพื้นที่ทีมเก็บงานที่ผ่านแล้ว</p>
          <label className="field"><span>ชื่อทีม</span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} placeholder="เช่น ทีมคลาวด์" /></label>
          <button className="btn btn-primary" disabled={busy}>สร้างทีม</button>
        </form>
        <form className="card pad form" onSubmit={join}>
          <h2><Icon name="users" /> เข้าร่วมด้วยรหัสเชิญ</h2>
          <p className="muted">ขอรหัสจากหัวหน้าทีม รูปแบบ CV-XXXXXX</p>
          <label className="field"><span>รหัสเชิญ</span><input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required placeholder="CV-7K2QX9" className="mono" /></label>
          <button className="btn btn-primary" disabled={busy}>เข้าร่วม</button>
        </form>
      </div>
    </>
  );
}

// หน้าทีม
function TeamPage({ companyId }) {
  const { refresh } = useAuth();
  const { toast, confirm } = useUi();
  const [run, busy] = useAction();
  const [company, setCompany] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [members, setMembers] = useState(null);
  const [teamFiles, setTeamFiles] = useState(null);
  const [tab, setTab] = useState('tasks');
  const [modal, setModal] = useState(null); // 'create-task' | 'disband'
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
        if (c.role === 'OWNER') {
          const [m, f] = await Promise.all([
            api('GET', `/companies/${companyId}/members`),
            api('GET', `/companies/${companyId}/files`),
          ]);
          setMembers(m);
          setTeamFiles(f);
        }
      }),
    [run, companyId],
  );
  useEffect(() => { load(); }, [load]);

  const rotate = async () => {
    if (!(await confirm({ title: 'เปลี่ยนรหัสเชิญ?', message: 'รหัสเดิมจะใช้ไม่ได้ทันที สมาชิกเดิมยังอยู่ครบ', confirmText: 'เปลี่ยนรหัส' }))) return;
    run(async () => {
      const { inviteCode } = await api('POST', `/companies/${companyId}/invite-code/rotate`);
      setCompany((c) => ({ ...c, inviteCode }));
    }, 'เปลี่ยนรหัสเชิญแล้ว');
  };

  const removeMember = async (m) => {
    if (!(await confirm({ title: `นำ ${m.name} ออกจากทีม?`, message: 'งานที่ยังรอตรวจของคนนี้จะถูกยกเลิกและปลดล็อกไฟล์คืนให้เขา งานที่ผ่านแล้วยังอยู่ในพื้นที่ทีม', confirmText: 'นำออก', danger: true }))) return;
    run(async () => { await api('DELETE', `/companies/${companyId}/members/${m.userId}`); await load(); }, 'นำสมาชิกออกแล้ว');
  };

  const leave = async () => {
    if (!(await confirm({ title: 'ออกจากทีม?', message: 'งานที่ยังรอตรวจจะถูกยกเลิกและไฟล์จะถูกปลดล็อก หลังออกแล้วเข้าร่วมทีมอื่นได้', confirmText: 'ออกจากทีม', danger: true }))) return;
    run(async () => {
      const me = await api('GET', '/me');
      await api('DELETE', `/companies/${companyId}/members/${me.user.userId}`);
      await refresh();
    }, 'ออกจากทีมแล้ว');
  };

  if (!company) return <Spinner />;
  const others = members ? members.members.filter((m) => m.role !== 'OWNER') : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{company.name}</h1>
          <p className="muted">{isOwner ? 'คุณเป็นหัวหน้าทีม' : 'คุณเป็นสมาชิกทีม'}</p>
        </div>
        {isOwner ? (
          <div className="invite-box">
            <span className="muted small">รหัสเชิญ</span>
            <code className="invite-code" data-testid="invite-code">{company.inviteCode}</code>
            <button className="icon-btn" title="คัดลอก" onClick={async () => toast((await copyText(company.inviteCode)) ? 'คัดลอกรหัสแล้ว' : 'คัดลอกไม่สำเร็จ')}><Icon name="copy" /></button>
            <button className="icon-btn" title="เปลี่ยนรหัสเชิญ" onClick={rotate} disabled={busy}><Icon name="refresh" /></button>
          </div>
        ) : (
          <button className="btn btn-danger-ghost" onClick={leave} disabled={busy}><Icon name="logout" size={16} />ออกจากทีม</button>
        )}
      </div>

      {isOwner && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'tasks'} className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}><Icon name="task" size={16} />งาน</button>
          <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Icon name="archive" size={16} />ไฟล์ของทีม</button>
          <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}><Icon name="users" size={16} />สมาชิก ({members?.members.length ?? '…'})</button>
        </div>
      )}

      {tab === 'tasks' && (
        <div className="card">
          <div className="card-head">
            <h2>{isOwner ? 'งานทั้งหมด' : 'งานที่ได้รับมอบหมาย'}</h2>
            {isOwner && (
              <button className="btn btn-primary btn-sm" onClick={() => setModal('create-task')} disabled={!members}>
                <Icon name="plus" size={16} />สร้างงาน
              </button>
            )}
          </div>
          {!tasks ? <div className="pad"><Spinner /></div> : tasks.length === 0 ? (
            <Empty icon="task" title={isOwner ? 'ยังไม่มีงาน' : 'ยังไม่มีงานที่มอบหมายให้คุณ'}>
              {isOwner && (others.length ? 'กด “สร้างงาน” เพื่อสั่งงานลูกทีม' : 'ส่งรหัสเชิญให้ลูกทีมเข้าร่วมก่อน แล้วค่อยสร้างงาน')}
            </Empty>
          ) : (
            <ul className="task-list">
              {tasks.map((t) => (
                <li key={t.taskId}>
                  <Link to={`/team/tasks/${t.taskId}`}>
                    <div className="grow min0">
                      <div className="task-title truncate">{t.title}</div>
                      <div className="meta">
                        <span><Icon name="clock" size={13} />{t.dueDate ? `กำหนดส่ง ${formatDate(t.dueDate)}` : 'ไม่มีกำหนดส่ง'}</span>
                        <span><Icon name="users" size={13} />ผู้รับผิดชอบ {t.assignees.length} คน</span>
                      </div>
                    </div>
                    {isOwner ? (
                      <div className="task-stats">
                        {t.pendingCount > 0 && <Stamp tone="warn">รอตรวจ {t.pendingCount}</Stamp>}
                        <span className="muted small">ผ่าน {t.approvedCount}/{t.assignees.length} คน</span>
                      </div>
                    ) : <StatusBadge status={t.myStatus} />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'files' && teamFiles && <TeamFilesTab companyId={companyId} data={teamFiles} onChanged={load} />}

      {tab === 'members' && members && (
        <>
          <div className="card">
            <div className="card-head"><h2>สมาชิก</h2><span className="muted small">พื้นที่ส่วนตัวของแต่ละคน (My Files)</span></div>
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
                          <div className="min0"><div className="truncate">{m.name} {m.role === 'OWNER' && <Badge>หัวหน้า</Badge>}</div><div className="muted small truncate">{m.email}</div></div>
                        </div>
                      </td>
                      <td className="usage-cell">
                        <div className="row-between small"><span>{formatBytes(m.usedBytes)}</span><span className="muted">{Math.round(pct)}%</span></div>
                        <div className="meter"><div className={`meter-fill ${pct > 90 ? 'bad' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
                      </td>
                      <td className="hide-sm muted">{formatDate(m.joinedAt)}</td>
                      <td className="actions">
                        {m.role !== 'OWNER' && <button className="btn btn-sm btn-danger-ghost" onClick={() => removeMember(m)} disabled={busy}>นำออก</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card danger-zone">
            <div className="pad row-between wrap">
              <div className="min0">
                <h2 className="text-bad">ยุบทีม</h2>
                <p className="muted small">
                  {others.length
                    ? `ต้องนำสมาชิกออกให้หมดก่อน (เหลืออีก ${others.length} คน) หัวหน้าทีมออกจากทีมไม่ได้`
                    : 'ลบทีม งานทั้งหมด และไฟล์ทุกไฟล์ในพื้นที่ทีมอย่างถาวร'}
                </p>
              </div>
              <button className="btn btn-danger" onClick={() => setModal('disband')} disabled={others.length > 0}
                title={others.length ? 'นำสมาชิกออกให้หมดก่อน' : ''}>ยุบทีม</button>
            </div>
          </div>
        </>
      )}

      {modal === 'create-task' && (
        <CreateTaskModal
          companyId={companyId}
          members={others}
          onClose={() => setModal(null)}
          onCreated={() => { setModal(null); load(); }}
        />
      )}
      {modal === 'disband' && (
        <DisbandModal company={company} teamFiles={teamFiles} onClose={() => setModal(null)} onDone={refresh} />
      )}
    </>
  );
}

// พื้นที่ทีม (เฉพาะหัวหน้า) + ค้นหาแยกของทีม
// ค้นจากชื่อไฟล์ ชื่อคนส่ง ชื่องาน หรือความเห็นตอน Approve และกรองตามงานได้
// ทุกไฟล์บอกที่มา: Approve จากงานไหน ใครส่ง เมื่อไหร่ กดแล้วไปที่การส่งงานนั้น
function TeamFilesTab({ companyId, data: initial, onChanged }) {
  const { toast, confirm } = useUi();
  const [run, busy] = useAction();
  const [archived, setArchived] = useState({});
  const [data, setData] = useState(initial);
  const [q, setQ] = useState('');
  const [taskId, setTaskId] = useState('');
  const [searching, setSearching] = useState(false);
  const filtered = Boolean(q.trim() || taskId);
  const pct = data.quotaBytes ? (data.usedBytes / data.quotaBytes) * 100 : 0;

  const fetchFiles = useCallback(async (query, task) => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (task) params.set('taskId', task);
    setSearching(true);
    try {
      setData(await api('GET', `/companies/${companyId}/files?${params}`));
    } finally {
      setSearching(false);
    }
  }, [companyId]);

  // ค้นหาเมื่อหยุดพิมพ์ 300 ms
  useEffect(() => {
    if (!filtered && data === initial) return undefined;
    const timer = setTimeout(() => fetchFiles(q, taskId).catch((err) => toast(err.message, 'bad')), 300);
    return () => clearTimeout(timer);
  }, [q, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = (f) =>
    run(async () => {
      try {
        startDownload((await api('GET', `/companies/${companyId}/files/${f.fileId}/download-url`)).url);
      } catch (err) {
        if (err.code !== 'ARCHIVED') throw err;
        setArchived((a) => ({ ...a, [f.fileId]: err.body.restoring ? 'restoring' : 'archived' }));
        toast(err.message, 'warn');
      }
    });
  const restore = (f) =>
    run(async () => {
      await api('POST', `/companies/${companyId}/files/${f.fileId}/restore`);
      setArchived((a) => ({ ...a, [f.fileId]: 'restoring' }));
    }, 'ส่งคำขอกู้คืนแล้ว ใช้เวลาประมาณ 12–48 ชั่วโมง');
  const remove = async (f) => {
    if (!(await confirm({
      title: `ลบ “${f.name}” ออกจากพื้นที่ทีม?`,
      message: `ไฟล์จะถูกลบถาวร คืนพื้นที่ทีม ${formatBytes(f.size)} และจะหายจาก “งานที่ส่งแล้ว” ของ ${f.userName} ด้วย`,
      confirmText: 'ลบถาวร',
      danger: true,
    }))) return;
    run(async () => {
      await api('DELETE', `/companies/${companyId}/files/${f.fileId}`);
      await Promise.all([fetchFiles(q, taskId), onChanged()]);
    }, 'ลบไฟล์ออกจากพื้นที่ทีมแล้ว');
  };

  return (
    <div className="card">
      <div className="card-head team-space">
        <div className="min0">
          <h2>พื้นที่ทีม</h2>
          <p className="muted small">งานที่ Approve แล้วจะถูกย้ายมาเก็บที่นี่ เห็นเฉพาะหัวหน้าทีม หลัง 3 วันระบบย้ายเข้า Glacier ให้เอง</p>
        </div>
        <div className="team-meter">
          <div className="row-between small"><span>ใช้ไป {formatBytes(data.usedBytes)} จาก {formatBytes(data.quotaBytes)}</span><span className={pct > 90 ? 'text-bad' : 'muted'}>{Math.round(pct)}%</span></div>
          <div className="meter"><div className={`meter-fill ${pct > 90 ? 'bad' : ''}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
        </div>
      </div>

      {data.totalCount > 0 && (
        <div className="team-search">
          <label className="search grow">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="ค้นหาไฟล์ของทีม: ชื่อไฟล์ คนส่ง ชื่องาน หรือความเห็นตอน Approve…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="ค้นหาไฟล์ของทีม"
              data-testid="team-search"
            />
            {searching && <Spinner />}
          </label>
          <select value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="กรองตามงาน" data-testid="team-task-filter">
            <option value="">ทุกงาน</option>
            {data.tasks.map((t) => <option key={t.taskId} value={t.taskId}>{t.taskTitle}</option>)}
          </select>
          {filtered && <span className="muted small nowrap">พบ {data.files.length} จาก {data.totalCount} ไฟล์</span>}
        </div>
      )}

      {data.totalCount === 0 ? (
        <Empty icon="archive" title="ยังไม่มีไฟล์ในพื้นที่ทีม">เมื่อคุณ Approve งาน ไฟล์จะถูกย้ายมาเก็บที่นี่</Empty>
      ) : data.files.length === 0 ? (
        <Empty icon="search" title="ไม่พบไฟล์ที่ตรงกับการค้นหา">
          <button className="btn btn-sm" onClick={() => { setQ(''); setTaskId(''); }}>ล้างการค้นหา</button>
        </Empty>
      ) : (
        <table className="table">
          <thead><tr><th>ชื่อไฟล์</th><th className="hide-sm">ที่มา (Approve จาก)</th><th>ขนาด</th><th className="right">จัดการ</th></tr></thead>
          <tbody>
            {data.files.map((f) => (
              <tr key={f.fileId}>
                <td>
                  <div className="file-cell">
                    <FileIcon name={f.name} />
                    <div className="min0">
                      <div className="truncate"><Highlight text={f.name} q={q} /></div>
                      <div className="muted small show-sm truncate">จาก {f.taskTitle}, ส่งโดย {f.userName}</div>
                    </div>
                  </div>
                </td>
                <td className="hide-sm origin-cell">
                  <Link to={`/team/tasks/${f.taskId}?sub=${f.submissionId}`} className="origin-link" title="ไปที่การส่งงานนี้">
                    <Icon name="task" size={14} /><span><Highlight text={f.taskTitle} q={q} /></span>
                  </Link>
                  <div className="meta">
                    <span><Icon name="user" size={13} /><Highlight text={f.userName} q={q} /></span>
                    {f.submittedAt && <span>ส่ง {formatDateTime(f.submittedAt)}</span>}
                  </div>
                  <div className="meta"><span><Icon name="check" size={13} />Approve {formatDateTime(f.approvedAt)}</span></div>
                  {f.reviewComment && <div className="origin-comment small">“<Highlight text={f.reviewComment} q={q} />”</div>}
                </td>
                <td className="muted">{formatBytes(f.size)}</td>
                <td className="actions">
                  {archived[f.fileId] === 'restoring' ? <Badge tone="warn" icon="archive">กำลังกู้คืน</Badge>
                    : archived[f.fileId] === 'archived' ? <button className="btn btn-sm" onClick={() => restore(f)} disabled={busy}><Icon name="archive" size={14} />ขอกู้คืน</button>
                      : <button className="icon-btn" title="ดาวน์โหลด" onClick={() => download(f)} disabled={busy}><Icon name="download" /></button>}
                  <button className="icon-btn danger" title="ลบออกจากพื้นที่ทีม" onClick={() => remove(f)} disabled={busy}><Icon name="trash" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// เน้นคำที่ค้นหาในข้อความ
function Highlight({ text = '', q }) {
  const needle = q.trim().toLocaleLowerCase('th');
  if (!needle) return text;
  const i = text.toLocaleLowerCase('th').indexOf(needle);
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}<mark>{text.slice(i, i + needle.length)}</mark>{text.slice(i + needle.length)}
    </>
  );
}

// ยุบทีม: ต้องพิมพ์ชื่อทีมให้ตรงก่อนกด
function DisbandModal({ company, teamFiles, onClose, onDone }) {
  const navigate = useNavigate();
  const [run, busy] = useAction();
  const [typed, setTyped] = useState('');
  const fileCount = teamFiles?.files.length ?? 0;
  const matches = typed.trim() === company.name;

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('DELETE', `/companies/${company.companyId}`, { confirmName: typed.trim() });
      await onDone();
      navigate('/');
    }, 'ยุบทีมแล้ว');
  };

  return (
    <Modal title={`ยุบทีม “${company.name}”`} onClose={onClose} width={500}>
      <form className="form" onSubmit={submit}>
        <div className="warn-box" role="alert">
          <strong><Icon name="trash" size={16} /> การยุบทีมกู้คืนไม่ได้</strong>
          <ul>
            <li>ไฟล์ทั้งหมดในพื้นที่ทีม <strong>{fileCount} ไฟล์ ({formatBytes(teamFiles?.usedBytes)})</strong> จะถูกลบถาวรจาก S3</li>
            <li>งาน ประวัติการส่งงาน และรหัสเชิญจะหายทั้งหมด</li>
            <li>อดีตสมาชิกจะไม่เห็นไฟล์เหล่านี้ใน “งานที่ส่งแล้ว” อีก (สำเนาที่ทำไว้ใน My Files ยังอยู่)</li>
            <li>ไฟล์ใน My Files ของคุณไม่ได้รับผลกระทบ</li>
          </ul>
        </div>
        <label className="field">
          <span>พิมพ์ <code className="mono">{company.name}</code> เพื่อยืนยัน</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="disband-confirm" />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>ยกเลิก</button>
          <button className="btn btn-danger" disabled={!matches || busy}>ยุบทีมและลบไฟล์ทั้งหมด</button>
        </div>
      </form>
    </Modal>
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

// รายละเอียดงาน
export function TaskPage() {
  const { taskId } = useParams();
  const [params] = useSearchParams();
  const focusSub = params.get('sub'); // มาจากผลค้นหาไฟล์ทีม → เน้นการส่งงานนั้น
  const { team } = useAuth();
  const companyId = team?.companyId;
  const [data, setData] = useState(null);
  const [run, busy] = useAction();
  const { toast } = useUi();
  const [showSubmit, setShowSubmit] = useState(false);
  const [review, setReview] = useState(null); // {submission, action}
  const [justReviewed, setJustReviewed] = useState(null); // ประทับตราใหม่ → เล่น animation ครั้งเดียว
  const [archived, setArchived] = useState({});
  const base = `/companies/${companyId}/tasks/${taskId}`;

  const load = useCallback(() => run(async () => setData(await api('GET', base))), [run, base]);
  useEffect(() => { if (companyId) load(); }, [load, companyId]);

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
  const requestRestore = (sub, file) =>
    run(async () => {
      await api('POST', `${base}/submissions/${sub.submissionId}/files/${file.fileId}/restore`);
      setArchived((a) => ({ ...a, [file.fileId]: 'restoring' }));
    }, 'ส่งคำขอกู้คืนแล้ว ใช้เวลาประมาณ 12–48 ชั่วโมง');

  // เลื่อนไปที่การส่งงานที่ถูกเลือกจากผลค้นหา
  useEffect(() => {
    if (data && focusSub) document.getElementById(`sub-${focusSub}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [data, focusSub]);

  if (!companyId) return <Navigate to="/team" replace />;
  if (!data) return <Spinner />;
  const { task, role, submissions, assignees } = data;
  const isOwner = role === 'OWNER';
  const hasPending = submissions.some((s) => s.status === 'PENDING');
  const latestByUser = Object.fromEntries([...submissions].reverse().map((s) => [s.userId, s.status]));

  return (
    <>
      <p className="crumb"><Link to="/team"><Icon name="back" size={16} />กลับไปหน้าทีม</Link></p>
      {focusSub && <p className="hint"><Icon name="search" size={14} /> การส่งงานที่ไฟล์นั้นถูก Approve ไฮไลต์ไว้ด้านล่าง</p>}
      <div className="page-head">
        <div>
          <h1>{task.title}</h1>
          <div className="meta" style={{ marginTop: 8 }}>
            <span><Icon name="clock" size={14} />{task.dueDate ? `กำหนดส่ง ${formatDate(task.dueDate)}` : 'ไม่มีกำหนดส่ง'}</span>
            <span>สร้างเมื่อ {formatDate(task.createdAt)}</span>
          </div>
        </div>
        {!isOwner && (
          <button className="btn btn-primary" onClick={() => setShowSubmit(true)} disabled={hasPending}
            title={hasPending ? 'มีงานที่รอตรวจอยู่แล้ว' : ''}>
            <Icon name="send" size={16} /> {hasPending ? 'รอหัวหน้าตรวจ' : 'ส่งงาน'}
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
              <li key={s.submissionId} id={`sub-${s.submissionId}`}
                className={`submission status-${s.status.toLowerCase()} ${focusSub === s.submissionId ? 'focused' : ''}`}>
                <div className="row-between">
                  <div>
                    {isOwner && <strong>{s.userName} </strong>}
                    <span className="muted small">ส่งเมื่อ {formatDateTime(s.createdAt)}</span>
                    {s.late && <Badge tone="bad">ส่งช้า</Badge>}
                  </div>
                  <StatusBadge status={s.status} fresh={justReviewed === s.submissionId} />
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
                {s.comment && <p className="comment"><strong>ความเห็นหัวหน้า:</strong> {s.comment}</p>}
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
        <ReviewModal base={base} {...review} onClose={() => setReview(null)}
          onDone={() => { setJustReviewed(review.submission.submissionId); setReview(null); load(); }} />
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
    }, approve ? 'Approve แล้ว ไฟล์ย้ายไปพื้นที่ทีม' : 'ส่งกลับให้แก้ไขแล้ว');
  };
  const total = submission.files.reduce((s, f) => s + f.size, 0);
  return (
    <Modal title={approve ? `Approve งานของ ${submission.userName}` : `ส่งกลับให้ ${submission.userName} แก้ไข`} onClose={onClose} width={500}>
      <form className="form" onSubmit={submit}>
        {approve ? (
          <p className="hint">ไฟล์ {submission.files.length} ไฟล์ ({formatBytes(total)}) จะย้ายไปพื้นที่ทีม (นับในพื้นที่ทีม) ผู้ส่งได้พื้นที่ส่วนตัวคืน หลัง 3 วันไฟล์จะถูกลดระดับเป็น Glacier Instant Retrieval อัตโนมัติ</p>
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
