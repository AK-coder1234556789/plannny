import { useEffect, useState } from 'react';
import {
  auth,
  provider,
  db,
  configured,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  onSnapshot,
  arrayUnion,
  arrayRemove,
} from './firebase';
import AiVoiceMic from './AiVoiceMic';

const SECTIONS = [['lectures', 'Lectures'], ['hw', 'HW'], ['doubts', 'Doubts']];
const EV = { test: ['Test', '#ef4444'], revision: ['Revision', '#3b82f6'], deadline: ['Deadline', '#f59e0b'], other: ['Other', '#a78bfa'] };
const DEF = { layout: 'columns', collapsed: false, accent: '#f97316', showPercent: true, wall: 'aurora', cd: { show: true, unit: 'days', color: '#f97316', size: 'm' } };
const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const left = (date) => Math.round((new Date(date + 'T00:00') - new Date(iso(new Date()) + 'T00:00')) / 864e5);

const friendly = (e) => {
  if (!e) return 'An unexpected error occurred.';
  const code = e.code || '';
  const map = {
    'auth/unauthorized-domain': 'This domain is not authorized in Firebase. Add it under Authentication > Settings > Authorized domains.',
    'auth/operation-not-allowed': 'Google sign-in is not enabled. Turn it on under Authentication > Sign-in method.',
    'auth/network-request-failed': 'No internet connection. Try again when you are online.',
    'auth/popup-blocked': 'Sign-in popup was blocked by browser. Please allow popups.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
  };
  return map[code] || e.message || String(e);
};

const GLogo = (
  <svg width="18" height="18" viewBox="0 0 48 48">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
    <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z" />
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
  </svg>
);

export default function App() {
  const [user, setUser] = useState(undefined);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unmounted = false;

    // Safety timeout: Never stay stuck on "Connecting Firebase..." forever
    const timer = setTimeout(() => {
      if (!unmounted) {
        setUser((curr) => (curr === undefined ? null : curr));
      }
    }, 2500);

    getRedirectResult(auth)
      .then((res) => {
        if (res?.user && !unmounted) {
          setUser(res.user);
        }
      })
      .catch((e) => {
        console.warn('Redirect check notice:', e);
        if (!unmounted && e?.code !== 'auth/popup-closed-by-user') {
          setErr(friendly(e));
        }
      });

    const unsubscribe = onAuthStateChanged(
      auth,
      (u) => {
        if (!unmounted) {
          setUser(u ?? null);
        }
      },
      (error) => {
        console.warn('onAuthStateChanged notice:', error);
        if (!unmounted) {
          setErr(friendly(error));
          setUser(null);
        }
      }
    );

    return () => {
      unmounted = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const login = async () => {
    setErr('');
    setBusy(true);
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.warn('Sign-in error:', e);
      if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
        try {
          await signInWithRedirect(auth, provider);
          return;
        } catch (redirectErr) {
          setErr(friendly(redirectErr));
        }
      } else if (e?.code !== 'auth/popup-closed-by-user' && e?.code !== 'auth/cancelled-popup-request') {
        setErr(friendly(e));
      }
      setBusy(false);
    }
  };

  if (user === undefined) {
    return (
      <div className="center muted">
        <div style={{ display: 'grid', gap: 10, placeItems: 'center' }}>
          <div className="ai-dot-pulse" style={{ background: 'var(--accent)', width: 12, height: 12 }} />
          <span>Connecting Firebase…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="center">
        <div className="card login">
          <div className="logo"><i className="ti ti-target" /></div>
          <h2>Plan every day.<br />Finish the syllabus.</h2>
          <p className="muted">Your tasks, notes and calendar sync in real time with Google & Firebase.</p>
          <button className="gbtn" onClick={login} disabled={busy}>
            {GLogo}{busy ? 'Signing in with Google…' : 'Sign in with Google'}
          </button>
          <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>Secured with Firebase Google Authentication</p>
          {err && <p className="err">{err}</p>}
        </div>
      </div>
    );
  }

  return <Main user={user} />;
}

function Item({ t, labels, upd, del }) {
  const on = labels.filter((l) => t.labelIds?.includes(l.id));
  const off = labels.filter((l) => !t.labelIds?.includes(l.id));
  return (
    <div className="item">
      <div className="row">
        {t.type === 'task' ? <input type="checkbox" checked={!!t.done} onChange={(e) => upd(t.id, { done: e.target.checked })} /> : <i className="ti ti-note muted" />}
        <span contentEditable suppressContentEditableWarning className={t.done ? 'done' : ''} onBlur={(e) => upd(t.id, { text: e.currentTarget.textContent })}>{t.text}</span>
        <button className="x" title="Delete" onClick={() => del(t.id)}><i className="ti ti-trash" /></button>
      </div>
      <div className="chips">
        {on.map((l) => <span key={l.id} className="chip" title="Remove label" onClick={() => upd(t.id, { labelIds: arrayRemove(l.id) })}>{l.name} ×</span>)}
        {off.length > 0 && (
          <select value="" onChange={(e) => e.target.value && upd(t.id, { labelIds: arrayUnion(e.target.value) })}>
            <option value="">+ label</option>
            {off.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

function Section({ id, title, items, add, ...p }) {
  const [v, setV] = useState('');
  const done = items.filter((t) => t.done);
  return (
    <div className="card">
      <h3>{title}</h3>
      {items.filter((t) => !t.done).map((t) => <Item key={t.id} t={t} {...p} />)}
      <form className="add" onSubmit={(e) => { e.preventDefault(); add(id, v, 'task'); setV(''); }}>
        <input
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); add(id, v, 'note'); setV(''); } }}
          placeholder="Add a task (Shift+Enter for a note)"
          title="Enter adds a task. Shift+Enter adds a note."
        />
        <button type="submit" className="plus" title="Add"><i className="ti ti-plus" /></button>
      </form>
      {done.length > 0 && <details><summary>{done.length} completed</summary>{done.map((t) => <Item key={t.id} t={t} {...p} />)}</details>}
    </div>
  );
}

function Countdown({ t, cd, go }) {
  if (!cd.show) return null;
  if (!t) return <button className="card cd" onClick={go}><div className="muted">No target yet</div><div className="big" style={{ color: cd.color }}>Set one</div></button>;
  const d = left(t.deadline);
  const hrs = Math.max(0, Math.ceil((new Date(t.deadline + 'T23:59') - new Date()) / 36e5));
  const val = d < 0 ? `${-d} days over` : cd.unit === 'weeks' ? `${Math.floor(d / 7)}w ${d % 7}d` : cd.unit === 'hours' ? `${hrs} hrs` : `${d} ${d === 1 ? 'day' : 'days'}`;
  return <div className={'card cd ' + cd.size}><div className="muted">{t.name}</div><div className="big" style={{ color: d < 0 ? '#ef4444' : cd.color }}>{val}</div></div>;
}

function Targets({ targets, base }) {
  const [n, setN] = useState(''); const [d, setD] = useState(''); const [note, setNote] = useState('');
  const add = (e) => {
    e.preventDefault();
    if (!n.trim() || !d) return;
    addDoc(collection(db, ...base, 'targets'), { name: n.trim(), deadline: d, note: note.trim(), pinned: false, createdAt: Date.now() });
    setN(''); setD(''); setNote('');
  };
  const pin = (id) => targets.forEach((t) => updateDoc(doc(db, ...base, 'targets', t.id), { pinned: t.id === id ? !t.pinned : false }));
  return (
    <div>
      <h2>Targets</h2>
      <form className="card tform" onSubmit={add}>
        <input value={n} onChange={(e) => setN(e.target.value)} placeholder="Target, e.g. Finish mechanics" />
        <input type="date" value={d} onChange={(e) => setD(e.target.value)} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Details (optional)" />
        <button className="pill">Add target</button>
      </form>
      {!targets.length && <div className="muted">No targets yet. Add a target with a deadline, then pin one to the countdown card.</div>}
      {[...targets].sort((a, b) => a.deadline.localeCompare(b.deadline)).map((t) => {
        const d = left(t.deadline);
        return (
          <div className="card trow" key={t.id}>
            <div><b>{t.name}</b><div className="muted">{t.deadline}{t.note && ' · ' + t.note}</div></div>
            <span style={{ color: d < 0 ? '#ef4444' : 'var(--accent)' }}>{d < 0 ? `${-d} days over` : `${d} days left`}</span>
            <button title="Show on countdown card" style={{ color: t.pinned ? 'var(--accent)' : undefined }} onClick={() => pin(t.id)}><i className={'ti ' + (t.pinned ? 'ti-pinned' : 'ti-pin')} /></button>
            <button title="Delete" onClick={() => deleteDoc(doc(db, ...base, 'targets', t.id))}><i className="ti ti-trash" /></button>
          </div>
        );
      })}
    </div>
  );
}

function Main({ user }) {
  const base = ['users', user.uid];
  const [tasks, setTasks] = useState([]); const [labels, setLabels] = useState([]); const [targets, setTargets] = useState([]);
  const [events, setEvents] = useState([]);
  const [evm, setEvm] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [sync, setSync] = useState('synced');
  const [s, setS] = useState(DEF);
  const [date, setDate] = useState(iso(new Date())); const [view, setView] = useState('day');
  const [open, setOpen] = useState(false); const [nl, setNl] = useState('');

  useEffect(() => {
    const sub = (n, f) => onSnapshot(collection(db, ...base, n), { includeMetadataChanges: true }, (q) => {
      f(q.docs.map((d) => ({ id: d.id, ...d.data() })));
      if (n === 'tasks') setSync(q.metadata.hasPendingWrites ? 'syncing' : 'synced');
    });
    const off = [sub('tasks', setTasks), sub('labels', setLabels), sub('targets', setTargets), sub('events', setEvents),
      onSnapshot(doc(db, ...base, 'settings', 'profile'), (d) => d.exists() && setS({ ...DEF, ...d.data(), cd: { ...DEF.cd, ...d.data().cd } }))];
    return () => off.forEach((f) => f());
  }, [user.uid]);
  useEffect(() => { document.documentElement.style.setProperty('--accent', s.accent); }, [s.accent]);
  useEffect(() => { document.body.dataset.wall = s.wall; }, [s.wall]);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const save = (p) => { const n = { ...s, ...p }; setS(n); setDoc(doc(db, ...base, 'settings', 'profile'), n); };
  const saveCd = (p) => save({ cd: { ...s.cd, ...p } });
  const add = (section, text, type, taskDate = date, labelName = null) => {
    if (!text?.trim()) return;
    let labelIds = [];
    if (labelName) {
      const match = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
      if (match) labelIds = [match.id];
    }
    return addDoc(collection(db, ...base, 'tasks'), {
      text: text.trim(),
      type: type || 'task',
      section: section || 'lectures',
      date: taskDate || date,
      done: false,
      labelIds,
      createdAt: Date.now(),
    });
  };
  const upd = (id, p) => updateDoc(doc(db, ...base, 'tasks', id), p);
  const del = (id) => deleteDoc(doc(db, ...base, 'tasks', id));
  const shift = (n) => { const d = new Date(date + 'T00:00'); d.setDate(d.getDate() + n); setDate(iso(d)); };

  // Label management with deletion
  const addLabel = (name) => {
    if (!name?.trim()) return;
    return addDoc(collection(db, ...base, 'labels'), { name: name.trim() });
  };

  const delLabel = async (id, name) => {
    if (!id) return;
    try {
      await deleteDoc(doc(db, ...base, 'labels', id));
      // Remove this label ID from any tasks that have it
      tasks
        .filter((t) => t.labelIds?.includes(id))
        .forEach((t) => {
          updateDoc(doc(db, ...base, 'tasks', t.id), { labelIds: arrayRemove(id) });
        });
      if (view === 'label:' + id) {
        setView('day');
      }
    } catch (e) {
      console.error('Failed to delete label:', e);
    }
  };

  // Voice command handlers across all application features
  const completeTaskVoice = async (query) => {
    const qLower = query.toLowerCase().trim();
    if (qLower === 'all' || qLower === 'all tasks' || qLower === 'everything') {
      const dayTasks = tasks.filter((t) => t.date === date && !t.done);
      for (const t of dayTasks) {
        await upd(t.id, { done: true });
      }
      return;
    }
    const matched = tasks.find((t) => t.text.toLowerCase().includes(qLower));
    if (matched) {
      await upd(matched.id, { done: true });
    }
  };

  const deleteTaskVoice = async (query) => {
    const qLower = query.toLowerCase().trim();
    const matched = tasks.find((t) => t.text.toLowerCase().includes(qLower));
    if (matched) {
      await del(matched.id);
    }
  };

  const addTargetVoice = async (name, deadline, note) => {
    if (!name?.trim()) return;
    await addDoc(collection(db, ...base, 'targets'), {
      name: name.trim(),
      deadline: deadline || date,
      note: note || '',
      pinned: false,
      createdAt: Date.now(),
    });
  };

  const pinTargetVoice = async (query) => {
    const qLower = query.toLowerCase().trim();
    const matched = targets.find((t) => t.name.toLowerCase().includes(qLower));
    if (matched) {
      targets.forEach((t) => updateDoc(doc(db, ...base, 'targets', t.id), { pinned: t.id === matched.id }));
    }
  };

  const deleteTargetVoice = async (query) => {
    const qLower = query.toLowerCase().trim();
    const matched = targets.find((t) => t.name.toLowerCase().includes(qLower));
    if (matched) {
      await deleteDoc(doc(db, ...base, 'targets', matched.id));
    }
  };

  const addEventVoice = async (title, evDate, time, type) => {
    if (!title?.trim()) return;
    await addDoc(collection(db, ...base, 'events'), {
      title: title.trim(),
      date: evDate || date,
      time: time || '',
      type: type || 'test',
    });
  };

  const deleteEventVoice = async (query) => {
    const qLower = query.toLowerCase().trim();
    const matched = events.find((e) => e.title.toLowerCase().includes(qLower));
    if (matched) {
      await deleteDoc(doc(db, ...base, 'events', matched.id));
    }
  };

  const deleteLabelVoice = async (name) => {
    const qLower = name.toLowerCase().trim();
    const matched = labels.find((l) => l.name.toLowerCase().includes(qLower));
    if (matched) {
      await delLabel(matched.id, matched.name);
    }
  };

  const updateSettingsVoice = (patch) => {
    if (patch.collapsed === '__toggle__') {
      save({ collapsed: !s.collapsed });
    } else {
      save(patch);
    }
  };

  const day = tasks.filter((t) => t.date === date).sort((a, b) => a.createdAt - b.createdAt);
  const checks = day.filter((t) => t.type === 'task');
  const nDone = checks.filter((t) => t.done).length;
  const pct = checks.length ? Math.round((nDone / checks.length) * 100) : 0;
  const p = { labels, upd, del };
  const target = targets.find((t) => t.pinned) || [...targets].filter((t) => left(t.deadline) >= 0).sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
  const cd = <Countdown t={target} cd={s.cd} go={() => setView('targets')} />;
  const sections = SECTIONS.map(([id, title]) => <Section key={id} id={id} title={title} items={day.filter((t) => t.section === id)} add={add} {...p} />);
  const status = !online ? { c: 'off', t: 'Offline (saved locally)' } : sync === 'syncing' ? { c: 'sync', t: 'Syncing…' } : { c: 'ok', t: 'Synced' };
  const lid = view.startsWith('label:') ? view.slice(6) : null;
  const lt = lid ? tasks.filter((t) => t.labelIds?.includes(lid)) : [];
  const currentLabelObj = lid ? labels.find((l) => l.id === lid) : null;
  const nav = (v, icon, text) => (
    <button key={v} className={'nav' + (view === v ? ' on' : '')} title={text} onClick={() => setView(v)}><i className={'ti ' + icon} /><span className="lbl">{text}</span></button>
  );

  return (
    <div className={'app' + (s.collapsed ? ' mini' : '')}>
      <aside>
        <div className="brand"><b className="lbl">Planner</b><button title="Toggle icon-only sidebar" onClick={() => save({ collapsed: !s.collapsed })}><i className={'ti ' + (s.collapsed ? 'ti-layout-sidebar-left-expand' : 'ti-layout-sidebar-left-collapse')} /></button></div>
        {s.layout === 'columns' && cd}
        {nav('day', 'ti-list-check', 'Day view')}
        {nav('calendar', 'ti-calendar', 'Calendar')}
        {nav('analysis', 'ti-chart-bar', 'Analysis')}
        {nav('targets', 'ti-target', 'Targets')}
        
        {/* Labels with deletion button */}
        <div className="muted lbl grp" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Labels</span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>({labels.length})</span>
        </div>
        <div className="labels-nav-group">
          {labels.map((l) => (
            <div key={l.id} className="label-nav-item">
              <button
                className={'nav' + (view === 'label:' + l.id ? ' on' : '')}
                title={l.name}
                onClick={() => setView('label:' + l.id)}
              >
                <i className="ti ti-tag" />
                <span className="lbl">{l.name}</span>
              </button>
              <button
                type="button"
                className="label-del-btn"
                title={`Remove label "${l.name}"`}
                onClick={(e) => {
                  e.stopPropagation();
                  delLabel(l.id, l.name);
                }}
              >
                <i className="ti ti-trash" />
              </button>
            </div>
          ))}
        </div>
        <form className="lab-add" onSubmit={(e) => { e.preventDefault(); addLabel(nl); setNl(''); }}>
          <input value={nl} onChange={(e) => setNl(e.target.value)} placeholder="New label" />
        </form>
        <div className="grow" />
        <div className="acct" title={user.email}>
          <span className="avw">
            {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : <span className="av">{(user.displayName || user.email || '?')[0].toUpperCase()}</span>}
            <i className={'sdot ' + status.c} />
          </span>
          <div className="lbl"><div>{user.displayName || user.email}</div><div className="muted">{status.t}</div></div>
          <button className="lbl" title="Sign out" onClick={() => signOut(auth)}><i className="ti ti-logout" /></button>
        </div>
        <button className="nav" title="Settings" onClick={() => setOpen(true)}><i className="ti ti-settings" /><span className="lbl">Settings</span></button>
      </aside>

      <main>
        {view === 'calendar' && <Calendar tasks={tasks} events={events} edit={setEvm} open={(d) => { setDate(d); setView('day'); }} />}
        {view === 'analysis' && <Analysis tasks={tasks} labels={labels} upd={upd} del={del} />}
        {view === 'targets' && <Targets targets={targets} base={base} />}
        {lid && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
              <h2>{currentLabelObj?.name || 'Label'}</h2>
              <button
                type="button"
                className="pill"
                style={{
                  background: '#ef44441c',
                  color: '#f87171',
                  border: '1px solid #ef444438',
                  fontSize: 12,
                  padding: '6px 14px',
                }}
                onClick={() => {
                  if (currentLabelObj) delLabel(currentLabelObj.id, currentLabelObj.name);
                }}
              >
                <i className="ti ti-trash" /> Remove Label
              </button>
            </div>
            {!lt.length && <p className="muted">Nothing here yet. Add this label to a task from the Day view or by voice.</p>}
            {[...new Set(lt.map((t) => t.date))].sort().reverse().map((d) => (
              <div className="card" key={d} style={{ marginTop: 12 }}>
                <h3>{d}</h3>
                {lt.filter((t) => t.date === d).map((t) => <Item key={t.id} t={t} {...p} />)}
              </div>
            ))}
          </div>
        )}
        {view === 'day' && (
          <>
            <header className="top">
              <div className="dnav">
                <button title="Previous day" onClick={() => shift(-1)}><i className="ti ti-chevron-left" /></button>
                <h2>{new Date(date + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</h2>
                <button title="Next day" onClick={() => shift(1)}><i className="ti ti-chevron-right" /></button>
                <button onClick={() => setDate(iso(new Date()))}>Today</button>
              </div>
              {s.showPercent && s.layout === 'columns' && <Progress pct={pct} done={nDone} total={checks.length} />}
            </header>

            <div className="evbar">
              {events.filter((e) => e.date === date).map((e) => <span key={e.id} className="ev" style={{ '--c': EV[e.type]?.[1] }} onClick={() => setEvm(e)}>{e.time && e.time + ' · '}{e.title}</span>)}
              <button className="evadd" onClick={() => setEvm({ date })}><i className="ti ti-plus" /> Event</button>
            </div>
            {s.layout === 'columns' ? <div className="cols">{sections}</div> : (
              <div className="stack">
                <div>{sections}</div>
                <div className="rail">
                  {cd}
                  {s.showPercent && <div className="card"><Progress pct={pct} done={nDone} total={checks.length} /></div>}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Global AI Voice Controller: Positioned fixed at bottom-right, enlarged suitably without text, controlling entire app */}
      <AiVoiceMic
        currentDate={date}
        currentView={view}
        labels={labels}
        tasks={tasks}
        targets={targets}
        events={events}
        settings={s}
        onNavigateView={(targetView) => setView(targetView)}
        onDateChange={(targetDate) => setDate(targetDate)}
        onAddTask={(sec, txt, typ, d, lbl) => add(sec, txt, typ, d, lbl)}
        onCompleteTask={(query) => completeTaskVoice(query)}
        onDeleteTask={(query) => deleteTaskVoice(query)}
        onAddTarget={(name, deadline, note) => addTargetVoice(name, deadline, note)}
        onPinTarget={(query) => pinTargetVoice(query)}
        onDeleteTarget={(query) => deleteTargetVoice(query)}
        onAddEvent={(title, evDate, time, type) => addEventVoice(title, evDate, time, type)}
        onDeleteEvent={(query) => deleteEventVoice(query)}
        onAddLabel={(name) => addLabel(name)}
        onDeleteLabel={(name) => deleteLabelVoice(name)}
        onUpdateSettings={(patch) => updateSettingsVoice(patch)}
        onToggleSettingsModal={(isOpen) => setOpen(isOpen)}
        onSignOut={() => signOut(auth)}
      />

      {evm && <EventModal ev={evm} base={base} onClose={() => setEvm(null)} />}
      {open && (
        <div className="modal" onClick={() => setOpen(false)}>
          <div className="card panel" onClick={(e) => e.stopPropagation()}>
            <h2>Settings</h2>
            <label>Layout<select value={s.layout} onChange={(e) => save({ layout: e.target.value })}><option value="columns">Columns</option><option value="stack">Stacked with side panel</option></select></label>
            <label>Icon-only sidebar<input type="checkbox" checked={s.collapsed} onChange={(e) => save({ collapsed: e.target.checked })} /></label>
            <label>Show today's completion<input type="checkbox" checked={s.showPercent} onChange={(e) => save({ showPercent: e.target.checked })} /></label>
            <label>Accent color<input type="color" value={s.accent} onChange={(e) => save({ accent: e.target.value })} /></label>
            <label>Wallpaper<select value={s.wall} onChange={(e) => save({ wall: e.target.value })}><option value="aurora">Aurora</option><option value="dusk">Dusk</option><option value="grid">Grid</option><option value="dots">Dots</option><option value="rings">Rings</option><option value="lines">Lines</option><option value="plain">Plain</option></select></label>
            <h3>Countdown card</h3>
            <label>Show card<input type="checkbox" checked={s.cd.show} onChange={(e) => saveCd({ show: e.target.checked })} /></label>
            <label>Show time as<select value={s.cd.unit} onChange={(e) => saveCd({ unit: e.target.value })}><option value="days">Days</option><option value="weeks">Weeks and days</option><option value="hours">Hours</option></select></label>
            <label>Size<select value={s.cd.size} onChange={(e) => saveCd({ size: e.target.value })}><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>
            <label>Number color<input type="color" value={s.cd.color} onChange={(e) => saveCd({ color: e.target.value })} /></label>
            <p className="muted">Pick which target the card shows by pinning it in Targets.</p>
            <button className="pill" onClick={() => signOut(auth)}>Sign out ({user.displayName || user.email})</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Calendar({ tasks, events, open, edit }) {
  const [m, setM] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const first = (m.getDay() + 6) % 7;
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const today = iso(new Date());
  const go = (n) => setM(new Date(m.getFullYear(), m.getMonth() + n, 1));
  const upcoming = events.filter((e) => e.date >= today).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 6);
  return (
    <div>
      <header className="top">
        <div className="dnav">
          <button title="Previous month" onClick={() => go(-1)}><i className="ti ti-chevron-left" /></button>
          <h2>{m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
          <button title="Next month" onClick={() => go(1)}><i className="ti ti-chevron-right" /></button>
        </div>
        <button className="pill" onClick={() => edit({ date: today })}><i className="ti ti-plus" /> Event</button>
      </header>
      <div className="cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div className="muted" key={d}>{d}</div>)}
        {Array.from({ length: first }, (_, i) => <div key={'b' + i} />)}
        {Array.from({ length: days }, (_, i) => {
          const d = iso(new Date(m.getFullYear(), m.getMonth(), i + 1));
          const ts = tasks.filter((t) => t.date === d && t.type === 'task');
          const done = ts.filter((t) => t.done).length;
          const all = tasks.filter((t) => t.date === d);
          const evs = events.filter((e) => e.date === d).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
          return (
            <div key={d} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(d)} className={'day' + (d === today ? ' today' : '') + ((first + i) % 7 > 3 ? ' r' : '')} onClick={() => open(d)}>
              <b>{i + 1}</b>
              <button className="dadd" title="Add event" onClick={(e) => { e.stopPropagation(); edit({ date: d }); }}><i className="ti ti-plus" /></button>
              {evs.slice(0, 2).map((e) => <span key={e.id} className="ev" style={{ '--c': EV[e.type]?.[1] }} title={e.title} onClick={(x) => { x.stopPropagation(); edit(e); }}>{e.title}</span>)}
              {evs.length > 2 && <span className="muted">+{evs.length - 2} more</span>}
              {ts.length > 0 && <><span className="muted">{done}/{ts.length} done</span><div className="bar"><i style={{ width: (done / ts.length) * 100 + '%' }} /></div></>}
              {(all.length > 0 || evs.length > 0) && (
                <span className="tip">
                  {evs.length > 0 && <span><span className="muted">Events</span>{evs.map((e) => <span key={e.id} className="tl">◆ {e.time ? e.time + ' ' : ''}{e.title}</span>)}</span>}
                  {SECTIONS.map(([id, title]) => {
                    const a = all.filter((t) => t.section === id);
                    return a.length > 0 && (
                      <span key={id}>
                        <span className="muted">{title}</span>
                        {a.slice(0, 4).map((t) => <span key={t.id} className={'tl' + (t.done ? ' dn' : '')}>{t.type === 'note' ? '• ' : t.done ? '✓ ' : '○ '}{t.text}</span>)}
                        {a.length > 4 && <span className="muted">+{a.length - 4} more</span>}
                      </span>
                    );
                  })}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Coming up</h3>
        {upcoming.length === 0 && <div className="muted">No events yet. Add a test date, revision day or deadline.</div>}
        {upcoming.map((e) => (
          <div key={e.id} className="row evrow" onClick={() => edit(e)}>
            <i className="dot" style={{ '--c': EV[e.type]?.[1] }} />
            <span>{e.title}</span>
            <span className="muted">{EV[e.type]?.[0]} · {e.date}{e.time ? ' · ' + e.time : ''}</span>
            <span className="muted">{left(e.date) === 0 ? 'today' : 'in ' + left(e.date) + 'd'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventModal({ ev, base, onClose }) {
  const [f, setF] = useState({ title: '', date: '', type: 'test', time: '', note: '', ...ev });
  const set = (p) => setF({ ...f, ...p });
  const save = async (e) => {
    e.preventDefault();
    if (!f.title.trim() || !f.date) return;
    const { id, ...data } = f;
    data.title = data.title.trim();
    if (id) await updateDoc(doc(db, ...base, 'events', id), data);
    else await addDoc(collection(db, ...base, 'events'), { ...data, createdAt: Date.now() });
    onClose();
  };
  return (
    <div className="modal" onClick={onClose}>
      <form className="card panel" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{ev.id ? 'Edit event' : 'New event'}</h2>
        <input autoFocus value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Title, e.g. DRT 1 test" />
        <label>Date<input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></label>
        <div className="seg evtypes">
          {Object.entries(EV).map(([k, [n, c]]) => <button type="button" key={k} className={f.type === k ? 'on' : ''} style={{ '--c': c }} onClick={() => set({ type: k })}><i className="dot" />{n}</button>)}
        </div>
        <label>Time (optional)<input type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} /></label>
        <input value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder="Note (optional)" />
        <div className="trow">
          <button className="pill" type="submit">Save</button>
          {ev.id && <button type="button" onClick={async () => { await deleteDoc(doc(db, ...base, 'events', ev.id)); onClose(); }}><i className="ti ti-trash" /> Delete</button>}
        </div>
      </form>
    </div>
  );
}

function Analysis({ tasks, labels, upd, del }) {
  const [range, setRange] = useState('daily');
  const [group, setGroup] = useState('age');
  const today = iso(new Date());
  const md = new Date(); md.setDate(md.getDate() - ((md.getDay() + 6) % 7));
  const mon = iso(md);
  const sd = new Date(md); sd.setDate(sd.getDate() + 6);
  const sun = iso(sd);
  const all = tasks.filter((t) => t.type === 'task');
  const rt = all.filter((t) => (range === 'daily' ? t.date === today : range === 'weekly' ? t.date >= mon && t.date <= sun : t.date <= today));
  const done = rt.filter((t) => t.done).length;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const pending = all.filter((t) => !t.done);
  const backlog = pending.filter((t) => t.date < today).length;
  const age = (t) => -left(t.date);
  const AGE = [['Over a week old', (a) => a >= 7], ['2 to 6 days old', (a) => a >= 2 && a < 7], ['Yesterday', (a) => a === 1], ['Today', (a) => a === 0], ['Upcoming', (a) => a < 0]];
  const groups = group === 'age' ? AGE.map(([n, f]) => [n, pending.filter((t) => f(age(t)))])
    : group === 'section' ? SECTIONS.map(([id, n]) => [n, pending.filter((t) => t.section === id)])
    : [...labels.map((l) => [l.name, pending.filter((t) => t.labelIds?.includes(l.id))]), ['No label', pending.filter((t) => !t.labelIds?.length)]];
  const trend = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); const k = iso(d); const a = all.filter((t) => t.date === k); return { k, total: a.length, done: a.filter((t) => t.done).length }; });
  const arow = (n, a) => { const d = a.filter((t) => t.done).length; return <div key={n} className="arow"><span>{n}</span><span className="muted">{d}/{a.length}</span><div className="bar"><i style={{ width: pct(d, a.length) + '%' }} /></div></div>; };
  const byLabel = labels.map((l) => [l.name, rt.filter((t) => t.labelIds?.includes(l.id))]).filter(([, a]) => a.length);
  return (
    <div>
      <header className="top">
        <h2>Analysis</h2>
        <div className="seg">{[['daily', 'Daily'], ['weekly', 'Weekly'], ['all', 'Till date']].map(([k, l]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}</div>
      </header>
      <div className="cols">
        <div className="card"><div className="muted">Completed</div><div className="big">{done}</div></div>
        <div className="card"><div className="muted">Uncompleted</div><div className="big">{rt.length - done}</div></div>
        <div className="card"><div className="muted">Completion</div><div className="big">{pct(done, rt.length)}%</div><div className="bar"><i style={{ width: pct(done, rt.length) + '%' }} /></div></div>
        <div className="card"><div className="muted">Backlog (before today)</div><div className="big" style={{ color: backlog ? '#f87171' : undefined }}>{backlog}</div></div>
      </div>
      <div className="cols" style={{ marginTop: 12 }}>
        <div className="card"><h3>By section</h3>{SECTIONS.map(([id, n]) => arow(n, rt.filter((t) => t.section === id)))}</div>
        <div className="card"><h3>By label</h3>{byLabel.length ? byLabel.map(([n, a]) => arow(n, a)) : <div className="muted">Add labels to tasks to see progress by topic.</div>}</div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Pending tasks</h3>
          <div className="seg">{[['age', 'By age'], ['section', 'By section'], ['label', 'By label']].map(([k, l]) => <button key={k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{l}</button>)}</div>
        </div>
        {pending.length === 0 && <div className="muted">Nothing pending. All caught up.</div>}
        {groups.filter(([, a]) => a.length).map(([name, a]) => (
          <div key={name} className="grpbox">
            <div className="muted grph" style={{ color: name === 'Over a week old' ? '#f87171' : undefined }}>{name} · {a.length}</div>
            {[...a].sort((x, y) => x.date.localeCompare(y.date)).map((t) => {
              const g = age(t);
              return (
                <div key={t.id} className="row prow">
                  <input type="checkbox" checked={!!t.done} onChange={(e) => upd(t.id, { done: e.target.checked })} />
                  <span>{t.text}</span>
                  <span className="muted">{SECTIONS.find(([id]) => id === t.section)?.[1]} · {g > 0 ? g + 'd ago' : g === 0 ? 'today' : 'in ' + -g + 'd'}</span>
                  {t.date < today && <button title="Move to today" onClick={() => upd(t.id, { date: today })}><i className="ti ti-arrow-right" /></button>}
                  <button className="x" title="Delete" onClick={() => del(t.id)}><i className="ti ti-trash" /></button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3>Last 14 days</h3>
        <div className="trend">{trend.map((x) => <div key={x.k} className="tb" title={`${x.k}: ${x.done}/${x.total} done`}><div className="tc"><i style={{ height: (x.total ? Math.max(6, pct(x.done, x.total)) : 3) + '%', opacity: x.total ? 1 : 0.25 }} /></div><span className="muted">{+x.k.slice(8)}</span></div>)}</div>
      </div>
    </div>
  );
}

function Progress({ pct, done, total }) {
  return (
    <div className="pchip">
      <span className="ring" style={{ '--p': pct }}><b>{pct}%</b></span>
      <span><span className="muted">Today's progress</span><br />{done} of {total} tasks</span>
    </div>
  );
}
