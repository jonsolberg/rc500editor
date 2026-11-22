/*
 * RC-500 Editor — user interface.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 */
(function () {
  'use strict';

  var P = window.RC500P, L = P.L, RC0 = window.RC0, PF = window.RCPlatform, AU = window.RCAudio;
  var VERSION = '2.49';

  // ------------------------------------------------------------------ state
  var S = {
    mem: null, sys: null,           // parsed databases
    origMem: null, origSys: null,   // as loaded / last saved (for "modified" marks)
    store: null,                    // ROLAND folder view (or null = factory data)
    files: null,                    // {memLoad, memWrite, memCounter, sysLoad, sysWrite, sysCounter}
    cur: 0,                         // selected memory index
    page: 'memory',
    undo: [], redo: [],
    clip: null,
    midi: new PF.Midi(),
    midiLog: [],
    followPedal: true, sendPcOnSelect: false,
    loops: null,                    // {index -> [{name, size}]}
    player: null
  };

  // ------------------------------------------------------------------ tiny DOM helper
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function $(id) { return document.getElementById(id); }
  function pad3(n) { return (n < 10 ? '00' : n < 100 ? '0' : '') + n; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind || '') }, msg);
    $('toasts').appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, kind === 'err' ? 7000 : 3500);
    setTimeout(function () { t.remove(); }, kind === 'err' ? 7600 : 4100);
  }
  function errToast(e) { console.error(e); toast(e && e.message ? e.message : String(e), 'err'); }

  /** Modal dialog. buttons: [{label, primary, onclick (return false to keep open)}] */
  function dialog(title, body, buttons) {
    var back = h('div', { class: 'modal-back' });
    var close = function () { back.remove(); };
    var box = h('div', { class: 'modal', role: 'dialog' },
      h('h2', null, title), h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-buttons' }, (buttons || [{ label: 'Close' }]).map(function (b) {
        return h('button', {
          class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: function () {
            var r = b.onclick ? b.onclick() : undefined;
            if (r && r.then) r.then(function (x) { if (x !== false) close(); }, errToast);
            else if (r !== false) close();
          }
        }, b.label);
      })));
    back.appendChild(box);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.body.appendChild(back);
    var f = box.querySelector('input,select'); if (f) f.focus();
    return close;
  }

  // ------------------------------------------------------------------ data access + undo
  function blk(i) { return S.mem.blocks[i === undefined ? S.cur : i]; }
  function sysBlk() { return S.sys.blocks[0]; }
  function mget(sec, key, i) { return RC0.get(blk(i), sec, key); }
  function sget(sec, key) { return RC0.get(sysBlk(), sec, key); }

  var group = null;
  function begin() { group = []; }
  function commit() {
    if (group && group.length) { S.undo.push(group); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
    group = null; refreshChrome();
  }
  function setField(db, bi, sec, key, val) {
    var b = (db === 'mem' ? S.mem : S.sys).blocks[bi];
    var old = RC0.get(b, sec, key);
    if (old === undefined || old === val) return;
    RC0.set(b, sec, key, val);
    var rec = { db: db, bi: bi, sec: sec, key: key, old: old, val: val };
    if (group) group.push(rec); else { S.undo.push([rec]); S.redo = []; refreshChrome(); }
  }
  function mset(sec, key, val, i) { setField('mem', i === undefined ? S.cur : i, sec, key, val); }
  function sset(sec, key, val) { setField('sys', 0, sec, key, val); }
  function undoRedo(from, to, useOld) {
    var g = from.pop(); if (!g) return;
    g.slice().reverse().forEach(function (r) { RC0.set((r.db === 'mem' ? S.mem : S.sys).blocks[r.bi], r.sec, r.key, useOld ? r.old : r.val); });
    to.push(g);
    if (g[0].db === 'mem') S.cur = g[0].bi;
    render();
  }

  function memDirty(i) {
    if (!S.origMem) return false;
    var a = S.mem.blocks[i].sections, b = S.origMem.blocks[i].sections;
    for (var s = 0; s < a.length; s++) for (var f = 0; f < a[s].fields.length; f++) if (a[s].fields[f][1] !== b[s].fields[f][1]) return true;
    return false;
  }
  function sysDirty() {
    var a = S.sys.blocks[0].sections, b = S.origSys.blocks[0].sections;
    for (var s = 0; s < a.length; s++) for (var f = 0; f < a[s].fields.length; f++) if (a[s].fields[f][1] !== b[s].fields[f][1]) return true;
    return false;
  }
  function anyDirty() { if (!S.mem) return false; for (var i = 0; i < S.mem.blocks.length; i++) if (memDirty(i)) return true; return sysDirty(); }

  // ------------------------------------------------------------------ field widgets
  function sel(list, value, onchange, disabledFn) {
    var s = h('select', { onchange: function () { onchange(+s.value); } });
    list.forEach(function (o, i) {
      var v = Array.isArray(o) ? o[0] : i, l = Array.isArray(o) ? o[1] : o;
      s.appendChild(h('option', { value: v, selected: v === value, disabled: disabledFn && disabledFn(v) }, l));
    });
    if (value !== undefined && s.value !== String(value)) s.appendChild(h('option', { value: value, selected: true }, '(' + value + ')'));
    return s;
  }
  function chk(value, onchange) {
    return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: !!value, onchange: function (e) { onchange(e.target.checked ? 1 : 0); } }), h('span'));
  }
  function num(value, min, max, onchange, step, scale) {
    scale = scale || 1;
    var i = h('input', {
      type: 'number', min: min / scale, max: max / scale, step: step || 1, value: scale === 1 ? value : (value / scale).toFixed(1),
      onchange: function () {
        var v = Math.round(parseFloat(i.value) * scale);
        if (isNaN(v)) v = value;
        v = Math.max(min, Math.min(max, v)); onchange(v);
      }
    });
    return i;
  }
  function slider(value, min, max, onchange, fmt) {
    fmt = fmt || String;
    var out = h('output', null, fmt(value));
    var r = h('input', {
      type: 'range', min: min, max: max, value: value,
      oninput: function () { out.textContent = fmt(+r.value); },
      onchange: function () { onchange(+r.value); }
    });
    return h('span', { class: 'slider' }, r, out);
  }
  /** A labelled control. A hint gets an ⓘ button that shows it below (works on touch screens too). */
  function row(label, ctrl, hint) {
    var r = h('div', { class: 'row' });
    var lab = h('label', null, label);
    if (hint) {
      var hintEl = h('div', { class: 'hint' }, hint);
      lab.appendChild(h('button', { class: 'ib', type: 'button', title: hint, 'aria-label': 'What is this?', onclick: function () { r.classList.toggle('showhint'); } }, 'i'));
      add(r, [lab, h('div', { class: 'ctl' }, ctrl), hintEl]);
    } else add(r, [lab, h('div', { class: 'ctl' }, ctrl)]);
    return r;
  }
  function card(title, body, extra) { return h('section', { class: 'card ' + (extra || '') }, h('h3', null, title), body); }

  // shorthand builders bound to memory / system
  // Fields that have their own control on the page (filled while rendering), so "All values" can leave them out.
  var covered = { mem: {}, sys: {} };
  function cover(db, sec, key, label) { var k = sec + '.' + key; if (label || !covered[db][k]) covered[db][k] = label || true; }
  function M(sec, key) {
    cover('mem', sec, key);
    return {
      v: mget(sec, key),
      set: function (v) { mset(sec, key, v); render(); }
    };
  }
  function Sy(sec, key) { cover('sys', sec, key); return { v: sget(sec, key), set: function (v) { sset(sec, key, v); render(); } }; }
  function mSel(label, sec, key, list, hint) { cover('mem', sec, key, label); var f = M(sec, key); return row(label, sel(list, f.v, f.set), hint); }
  function mChk(label, sec, key, hint) { cover('mem', sec, key, label); var f = M(sec, key); return row(label, chk(f.v, f.set), hint); }
  function mLvl(label, sec, key, max, hint) { cover('mem', sec, key, label); var f = M(sec, key); return row(label, slider(f.v, 0, max || 200, f.set), hint); }
  function sSel(label, sec, key, list, hint) { cover('sys', sec, key, label); var f = Sy(sec, key); return row(label, sel(list, f.v, f.set), hint); }
  function sChk(label, sec, key, hint) { cover('sys', sec, key, label); var f = Sy(sec, key); return row(label, chk(f.v, f.set), hint); }

  // ------------------------------------------------------------------ chrome (header + memory list)
  var PLUG_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v15M12 15l-5-3V9M12 13l5-3V8"/></g><g fill="currentColor"><path d="M12 1.5l2.6 3.5H9.4z"/><circle cx="12" cy="20" r="2.2"/><circle cx="7" cy="7.6" r="1.7"/><rect x="15.4" y="4.9" width="3.2" height="3.2" rx=".4"/></g></svg>';
  function pedalOk() { return S.midi.connected && /RC-?500|BOSS|Roland/i.test(S.midi.name || 'RC-500'); }
  function refreshChrome() {
    var dirty = anyDirty();
    var st = $('status');
    st.innerHTML = '';
    add(st, [
      h('span', { class: 'plug ' + (S.midi.connected ? 'ok' : 'off'), html: PLUG_SVG }),
      h('span', { class: 'only-wide' }, !S.midi.connected ? 'Pedal not connected' : /RC-?500|BOSS|Roland/i.test(S.midi.name || 'RC-500') ? 'Pedal connected' : 'Connected to ' + S.midi.name + ' (not an RC-500)'),
      h('span', { class: 'sep only-wide' }, '·'),
      h('span', { class: 'only-wide' }, S.store ? 'Memories from your pedal' : 'Factory settings'),
      dirty ? h('span', { class: 'unsaved' }, 'unsaved') : null
    ]);
    st.title = (S.midi.connected ? 'Connected to ' + S.midi.name : 'The pedal is not connected over USB') + ' — ' +
      (S.store ? 'editing the memories loaded from the pedal' + (S.files ? ' (' + S.files.memName + ')' : '') : 'editing factory settings, not your pedal') + '. Tap for details.';
    $('memPick').innerHTML = '';
    if (S.mem) add($('memPick'), [h('b', null, pad2(S.cur + 1)), ' ' + RC0.memName(blk()).trim(), h('span', { class: 'caret' }, '▾')]);
    $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
    $('btnSave').classList.toggle('attention', dirty);
    renderMemList();
  }

  /** Small pop-up menu next to a button. items: [{label, onclick, disabled}] or null for a divider. */
  function popMenu(anchor, items) {
    var back = h('div', { class: 'menu-back', onclick: function (e) { if (e.target === back) back.remove(); } });
    var m = h('div', { class: 'menu', role: 'menu' }, items.map(function (it) {
      if (!it) return h('hr');
      return h('button', { role: 'menuitem', disabled: it.disabled, onclick: function () { back.remove(); it.onclick(); } }, it.label);
    }));
    back.appendChild(m); document.body.appendChild(back);
    var r = anchor.getBoundingClientRect();
    var left = Math.min(window.innerWidth - m.offsetWidth - 8, Math.max(8, r.right - m.offsetWidth));
    var top = r.bottom + 6;
    if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 6);
    m.style.left = left + 'px'; m.style.top = top + 'px';
  }

  /** Tap on the connection light: what is connected, what is being edited, and the next useful action. */
  function statusPopup() {
    var anchor = $('status');
    var back = h('div', { class: 'menu-back', onclick: function (e) { if (e.target === back) back.remove(); } });
    var close = function () { back.remove(); };
    var conn = S.midi.connected, ok = pedalOk();
    var box = h('div', { class: 'menu statuspop', role: 'dialog' },
      h('div', { class: 'srow' }, h('span', { class: 'plug ' + (conn ? 'ok' : 'off'), html: PLUG_SVG }),
        h('div', null, h('b', null, !conn ? 'Pedal not connected' : ok ? 'Pedal connected' : 'Not an RC-500'),
          h('small', null, !conn ? 'Connect the RC-500 with a USB cable that carries data.' : S.midi.name + (S.storage ? ' · in storage mode' : '')))),
      h('div', { class: 'srow' }, h('span', { class: 'sicon' }, S.store ? '⤓' : '🏭'),
        h('div', null, h('b', null, S.store ? 'Memories from your pedal' : 'Factory settings'),
          h('small', null, S.store ? (S.files ? 'Loaded from ' + S.files.memName : 'Loaded from a backup or folder') : 'Not your pedal’s memories – use Load from pedal to edit yours.'))),
      anyDirty() ? h('div', { class: 'srow' }, h('span', { class: 'sicon dirty' }, '●'),
        h('div', null, h('b', null, 'Unsaved changes'), h('small', null, 'Save to pedal writes them to the pedal.'))) : null,
      h('div', { class: 'sbtns' },
        !conn ? h('button', { class: 'primary', onclick: function () { close(); connectMidi(); } }, 'Connect') : null,
        conn ? h('button', { onclick: function () { close(); S.midi.disconnect(); render(); } }, 'Disconnect') : null,
        h('button', { onclick: function () { close(); go('start'); } }, 'Start page')));
    back.appendChild(box); document.body.appendChild(back);
    var r = anchor.getBoundingClientRect();
    box.style.left = Math.max(8, Math.min(window.innerWidth - box.offsetWidth - 8, r.left)) + 'px';
    box.style.top = (r.bottom + 6) + 'px';
  }

  var THEMES = { auto: ['◐', 'Theme: automatic'], light: ['☀', 'Theme: light'], dark: ['☾', 'Theme: dark'] };
  function nextTheme() {
    var t = localStorage.getItem('rc500-theme') || 'auto';
    try { localStorage.setItem('rc500-theme', { auto: 'light', light: 'dark', dark: 'auto' }[t]); } catch (e) { }
    applyTheme();
  }
  /**
   * Storage mode can also end on the pedal itself (EXIT, a footswitch, unplugging), and nothing tells us.
   * While we think it is on, ask the pedal now and then; two "off" answers in a row mean it has left.
   * (Android otherwise keeps showing the old drive, which only holds what was already read.)
   */
  var storageWatchOff = 0;
  setInterval(function () {
    if (!S.storage || !S.midi.connected || !S.midi.sysexOk || storageLock || document.hidden) { storageWatchOff = 0; return; }
    S.midi.queryEditMode(1500).then(function (v) {
      if (v !== 0 || !S.storage || storageLock) { if (v >= 0) storageWatchOff = 0; return; }
      if (++storageWatchOff < 2) return;
      storageWatchOff = 0;
      S.storage = false; S.autoStorage = false; S.loopDriveGone = true; S.loopTried = false; S.driveWritten = false;
      logMidi('mark', null, '──── the pedal left storage mode by itself ────');
      toast(PF.isAndroid
        ? 'The pedal has left storage mode. Eject its drive in My Files; for the loops again, unplug, start storage mode on the pedal and plug back in.'
        : 'The pedal has left storage mode.');
      render();
    });
  }, 3000);

  /** The header button switches theme (automatic → light → dark). */
  function moreMenu() { nextTheme(); }
  // The open tab is kept only for this visit (a reload stays put); a new visit always starts on Start.
  function go(p) {
    S.page = p; try { sessionStorage.setItem('rc500-page', p); } catch (e) { }
    if (p === 'loops') {
      S.loopTried = false;                        // the Loops tab opens the pedal's drive by itself, once per visit
      if (LS() && LS().hasWave) driveReachable(LS()).then(function (ok) { if (!ok && S.page === 'loops') { S.loopDriveGone = true; render(); } });
    }
    render(); window.scrollTo(0, 0);
  }

  /** A dialog that shows progress text; returns {set, close}. */
  function busy(text) {
    var msg = h('p', null, text);
    var back = h('div', { class: 'modal-back' }, h('div', { class: 'modal busy' }, h('div', { class: 'spinner' }), msg));
    document.body.appendChild(back);
    return {
      set: function (t) { msg.textContent = t; }, close: function () { back.remove(); },
      hide: function () { back.style.display = 'none'; }, show: function () { back.style.display = ''; }
    };
  }

  function renderMemList() {
    var ul = $('memlist'); if (!S.mem) return;
    var q = ($('memfilter').value || '').toLowerCase();
    ul.innerHTML = '';
    S.mem.blocks.forEach(function (b, i) {
      var name = RC0.memName(b).trim();
      if (q && name.toLowerCase().indexOf(q) < 0 && String(i + 1).indexOf(q) < 0) return;
      var li = h('li', {
        class: (i === S.cur ? 'sel ' : '') + (memDirty(i) ? 'dirty' : ''),
        onclick: function () { selectMemory(i); }
      }, h('span', { class: 'no' }, pad2(i + 1)), h('span', { class: 'nm' }, name || '—'),
        S.loops && S.loops[i] && (S.loops[i][1] || S.loops[i][2]) ? h('span', { class: 'wav', title: 'Has recorded loop' }, '●') : null);
      ul.appendChild(li);
    });
    // Keep the selected memory visible (scrollIntoViewIfNeeded doesn't exist in Firefox).
    var selEl = ul.querySelector('.sel');
    if (selEl) {
      var top = selEl.offsetTop - ul.offsetTop, bottom = top + selEl.offsetHeight;
      if (top < ul.scrollTop) ul.scrollTop = Math.max(0, top - selEl.offsetHeight * 2);
      else if (bottom > ul.scrollTop + ul.clientHeight) ul.scrollTop = bottom - ul.clientHeight + selEl.offsetHeight * 2;
    }
  }

  function selectMemory(i, fromPedal, noRender) {
    S.cur = i;
    if ((S.sendPcOnSelect || S.page === 'direct') && S.midi.connected && !fromPedal) { try { midiSend([0xC0 | rxCh(), i]); } catch (e) { errToast(e); } }
    if (S.page === 'start' || S.page === 'about') S.page = 'memory';
    if (window.RCDirect) RCDirect.onMemory();
    if (noRender) { renderMemList(); return; }
    render();
    document.body.classList.remove('show-list');
  }
  function rxCh() { var c = sget('MIDI', 'RxCtlCh'); return c === undefined ? 0 : c; }

  // ------------------------------------------------------------------ pages
  function render() {
    refreshChrome();
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.page === S.page); });
    var main = $('main');
    var st = main.scrollTop;
    main.innerHTML = '';
    var page = { start: pageStart, memory: pageMemory, system: pageSystem, loops: pageLoops, remote: pageRemote, about: pageAbout, direct: function () { return RCDirect.page(API); } }[S.page] || pageStart;
    add(main, page());
    main.scrollTop = st;
    renderMidiLog();
    // Keep the selected memory in view in long lists (Loops) when the selection changes.
    if (S.page === 'loops' && S.lastScrolled !== S.cur) {
      var row = main.querySelector('table.loops tr.sel');
      if (row) { row.scrollIntoView({ block: 'center' }); S.lastScrolled = S.cur; }
    } else if (S.page !== 'loops') S.lastScrolled = null;
  }

  function beatIdx() { return mget('RHYTHM', 'Beat'); }

  function trackCard(t) {
    var sec = 'TRACK' + t;
    var meas = M(sec, 'Measure');
    var tempo = mget(sec, 'RecTmp'), wl = mget(sec, 'WavLen'), ws = mget(sec, 'WavStat');
    return card('Track ' + t, [
      mLvl('Level', sec, 'PlyLvl', 200, 'Playback level (0–200, 100 = unity)'),
      (function () { var f = M(sec, 'Pan'); return row('Pan', slider(f.v, 0, 100, f.set, function (v) { return L.pan[v]; })); })(),
      mChk('Reverse', sec, 'Rev', 'Reverse playback. You cannot overdub a reversed track.'),
      mChk('Play once', sec, 'One', 'Play the phrase once and stop (one-shot); press again to play it again.'),
      mChk('Loop FX', sec, 'LoopFx', 'Let the loop effect work on this track.'),
      mSel('Starts', sec, 'StrtMod', L.start, 'How the track starts playing.'),
      mSel('Stops', sec, 'StpMod', L.stop, 'How the track stops when you press STOP: at once, with a fade out, or when the loop reaches its end.'),
      row('Loop length', sel(L.measure, meas.v, function (v) {
        begin(); mset(sec, 'Measure', v);
        var mf = P.measureFields(v); Object.keys(mf).forEach(function (k) { mset(sec, k, mf[k]); });
        commit(); render();
      }), 'Auto: the same length as the first track. Free: as long as you record. Otherwise a fixed length. Only used when “Sync with the other track” is on.'),
      mChk('Sync with the other track', sec, 'LoopSync', 'Keep the loop in step with the other track (LOOP SYNC).'),
      mChk('Follow the memory tempo', sec, 'TempoSync', 'On: play at the memory’s tempo. Off: play at the tempo it was recorded at (TEMPO SYNC).'),
      mSel('Records from', sec, 'Input', L.input),
      mSel('Plays to', sec, 'Output', L.output),
      h('p', { class: 'info' }, ws ? 'Recorded phrase: ' + (wl ? wl.toLocaleString() + ' samples, ' : '') + 'recorded at ' + (tempo / 10).toFixed(1) + ' BPM' : 'No phrase recorded')
    ]);
  }

  function pageMemory() {
    var i = S.cur, b = blk();
    var name = RC0.memName(b);
    var head = h('div', { class: 'memhead' },
      h('div', { class: 'memtitle' }, h('span', { class: 'big' }, pad2(i + 1)),
        h('input', {
          class: 'name', maxlength: 12, value: name.replace(/\s+$/, ''), spellcheck: 'false', title: 'Memory name (12 characters)',
          onchange: function (e) {
            begin(); var v = e.target.value.slice(0, 12);
            for (var c = 0; c < 12; c++) { var cc = c < v.length ? v.charCodeAt(c) : 32; if (cc < 32 || cc > 126) cc = 95; mset('NAME', 'C' + pad2(c + 1), cc); }
            commit(); render();
          }
        })),
      h('button', { class: 'iconbtn only-narrow', 'aria-label': 'Memory actions', onclick: function (e) {
        popMenu(e.currentTarget, [
          { label: '⧉ Copy to other memories…', onclick: copyDialog },
          { label: 'Copy', onclick: function () { S.clip = RC0.cloneSections(b); toast('Memory ' + (i + 1) + ' copied'); } },
          { label: 'Paste…', disabled: !S.clip, onclick: pasteDialog },
          { label: '⇄ Swap with…', onclick: swapDialog },
          null,
          { label: '⬇ Save as preset file', onclick: function () { exportPreset().catch(errToast); } },
          { label: '⬆ Load a preset file', onclick: function () { importPreset().catch(errToast); } },
          null,
          { label: 'Initialize (factory settings)', onclick: resetMemory }
        ]);
      } }, '⋯'),
      h('div', { class: 'tools only-wide' },
        h('button', { onclick: copyDialog, title: 'Copy this memory to other memories' }, '⧉ Copy to…'),
        h('button', { onclick: function () { S.clip = RC0.cloneSections(b); toast('Memory ' + (i + 1) + ' copied'); render(); } }, 'Copy'),
        h('button', { disabled: !S.clip, onclick: pasteDialog }, 'Paste…'),
        h('button', { onclick: swapDialog }, '⇄ Swap…'),
        h('button', { onclick: exportPreset, title: 'Save this memory as a preset file' }, '⬇ Preset'),
        h('button', { onclick: importPreset, title: 'Load a preset file into this memory' }, '⬆ Preset'),
        h('button', { class: 'danger', onclick: resetMemory }, 'Initialize')));

    var rhythmOn = mget('RHYTHM', 'State');
    cover('mem', 'RHYTHM', 'State', 'Rhythm on'); cover('mem', 'RHYTHM', 'Beat', 'Time signature');
    var fxType = mget('LOOPFX', 'FxType'), kind = P.fxKind(fxType);
    var tempo = M('MASTER', 'Tempo');

    var lenKey = { scatter: 'ScatterLength', repeat: 'RepeatLength', shift: 'ShiftShift' }[kind];
    var lenOpts = kind === 'vinyl' ? null : P.fxLengths(kind, beatIdx());

    var assigns = [];
    for (var a = 1; a <= 8; a++) assigns.push(assignRow(a));

    var sysPref = { Pedal1: 'Pdl1', Pedal2: 'Pdl2', Pedal3: 'Pdl3', Ctl1: 'Ctl1', Ctl2: 'Ctl2', Exp: 'Exp' }, anySys = false;
    function ctlRow(label, key, list) {
      var usesSys = sget('PREF', sysPref[key]) === 1;
      var f = M('CTL', key);
      var s = sel(RCNames.options(list), f.v, f.set);
      if (usesSys) { s.classList.add('dim'); anySys = true; }
      var r = row(label, [s, usesSys ? h('span', { class: 'note warnnote', title: 'This switch follows the system setting: ' + RCNames.plain(list[sget('CTL', key)]) }, 'uses system: ' + RCNames.plain(list[sget('CTL', key)])) : null]);
      r.classList.add('stack'); return r;
    }

    return [head, h('div', { class: 'grid' },
      trackCard(1), trackCard(2),
      card('Record', [
        mSel('Overdubbing', 'MASTER', 'DubMode', L.dubMode, 'Overdub adds new playing on top. Replace records over what was there.'),
        mSel('After recording', 'MASTER', 'RecAction', L.recAction, 'What pressing REC/PLAY at the end of a recording does: go straight on to overdubbing, or play back first.'),
        (function () { var f = M('MASTER', 'RecQuantize'); return row('Quantize', sel(L.quantize, f.v ? 1 : 0, function (v) { f.set(v ? 2 : 0); }), 'Moves the start and end of a recording to the nearest measure when the rhythm or another synced track is running.'); })(),
        mChk('Start recording when I play', 'MASTER', 'AutoRec', 'REC/PLAY waits, and recording starts when you start playing (AUTO REC).'),
        (function () { var f = M('MASTER', 'AutoRecSens'); return row('…how loud', slider(f.v, 1, 100, f.set), 'How loud you must play before recording starts (higher = reacts to softer playing).'); })(),
        mSel('…listening to', 'MASTER', 'AutoRecSrc', L.recSrc, 'Which input it listens to.'),
        (function () { var f = M('MASTER', 'LpLen'); return row('Loop length', [num(f.v, 0, 25362, f.set), h('span', { class: 'note' }, f.v ? 'measures' : 'auto')], '0 = auto: the length of the first recording.'); })()
      ]),
      card('Play', [
        row('Tempo', [num(tempo.v, 400, 3000, tempo.set, 0.1, 10), h('span', { class: 'note' }, 'BPM'), h('button', { class: 'small', onclick: tapTempo, title: 'Tap repeatedly' }, 'Tap')]),
        mLvl('Memory level', 'MASTER', 'Level', 200),
        mSel('Tracks play', 'MASTER', 'PlayMode', L.playMode, 'Both tracks play together, or one at a time and you switch with TRACK SELECT.'),
        mSel('Switch track', 'MASTER', 'SinglPlayeChange', L.singleChange, 'When playing one track at a time: switch to the other track at once, or when the loop ends.'),
        mSel('Fade time', 'MASTER', 'FadeTime', L.fadeTime, 'How long fade in and fade out take, for tracks set to start or stop that way.'),
        mSel('MIDI start plays', 'MASTER', 'AllStart', L.allStart, 'Which tracks start when a MIDI Start message arrives.'),
        mSel('Track chain', 'MASTER', 'TrackChain', L.trkChain, 'Parallel: both tracks play side by side. Series: track 1 is fed into track 2.')
      ]),
      card('Loop FX', [
        mChk('Loop FX on', 'LOOPFX', 'Sw', 'An effect that chops up, repeats or shifts the loop in time with the beat.'),
        mSel('Effect', 'LOOPFX', 'FxType', L.fxType, 'Scatter chops the loop up, Repeat repeats a short part, Shift moves it in time, Vinyl flick sounds like a record being stopped.'),
        lenOpts ? (function () {
          var f = M('LOOPFX', lenKey);
          return row({ scatter: 'Chop length', repeat: 'Repeat length', shift: 'Shift by' }[kind],
            sel(lenOpts.map(function (o) { return [o.value, o.label]; }), f.v, f.set, function (v) { return !lenOpts.filter(function (o) { return o.value === v; })[0].enabled; }),
            'Lengths that don’t fit the beat are greyed out.');
        })() : (function () { var f = M('LOOPFX', 'VinylFlickFlick'); return row('Flick amount', slider(f.v, 0, 100, f.set)); })()
      ]),
      card('Rhythm', [
        row('Rhythm on', chk(rhythmOn, function (v) { mset('RHYTHM', 'State', v); render(); }), 'The rhythm is ready to play when you pick this memory.'),
        mLvl('Level', 'RHYTHM', 'Level', 200),
        (function () { var f = M('RHYTHM', 'Reverb'); return row('Reverb', slider(f.v, 0, 100, f.set)); })(),
        row('Time signature', sel(L.beat, beatIdx(), function (v) {
          begin(); var pat = P.patterns(beatIdx())[mget('RHYTHM', 'Pattern')];
          mset('RHYTHM', 'Beat', v);
          var np = P.patterns(v).indexOf(pat); mset('RHYTHM', 'Pattern', np < 0 ? 0 : np);
          commit(); render();
        }), 'Can’t be changed after a track is recorded.'),
        mSel('Pattern', 'RHYTHM', 'Pattern', P.patterns(beatIdx())),
        mSel('Variation', 'RHYTHM', 'Variation', L.variation, 'Two versions of each pattern, A and B.'),
        mSel('Switch variation', 'RHYTHM', 'VariationChange', L.varChange, 'When a change between A and B takes effect: at the next measure or when the loop ends.'),
        mSel('Drum kit', 'RHYTHM', 'Kit', L.kit),
        mSel('Rhythm starts', 'RHYTHM', 'Start', L.rhyStart, 'With the loop: when you start recording or playing. After recording: when the first recording ends. Before recording: the rhythm plays first, and recording starts on the next measure.'),
        mSel('Rhythm stops', 'RHYTHM', 'Stop', L.rhyStop, 'Keeps playing until you stop it, stops with the loop, or stops when recording ends.'),
        mSel('Count-in before recording', 'RHYTHM', 'RecCount', L.count),
        mSel('Count-in before playing', 'RHYTHM', 'PlayCount', L.count),
        mChk('Fill-ins', 'RHYTHM', 'Fill', 'Play a drum fill when the variation changes.'),
        row('Drum parts', [1, 2, 3, 4].map(function (p) { var f = M('RHYTHM', 'Part' + p); return h('label', { class: 'inl' }, h('input', { type: 'checkbox', checked: !!f.v, onchange: function (e) { f.set(e.target.checked ? 1 : 0); } }), ' ' + p); })),
        mSel('Bass', 'RHYTHM', 'ToneLow', L.tone),
        mSel('Treble', 'RHYTHM', 'ToneHigh', L.tone)
      ]),
      card('Pedals & controllers', [
        ctlRow('REC/PLAY switch', 'Pedal1', L.pdlCtl),
        ctlRow('STOP switch', 'Pedal2', L.pdlCtl),
        ctlRow('TRACK SELECT switch', 'Pedal3', L.pdlCtl),
        ctlRow('Footswitch CTL1', 'Ctl1', L.pdlCtl),
        ctlRow('Footswitch CTL2', 'Ctl2', L.pdlCtl),
        ctlRow('Expression pedal', 'Exp', L.exp),
        h('p', { class: 'info' }, 'What each switch does in this memory.'),
        (function () {
          var any = ['Pdl1', 'Pdl2', 'Pdl3', 'Ctl1', 'Ctl2', 'Exp'].some(function (k) { return sget('PREF', k) === 1; });
          return any ? h('p', { class: 'info warnnote' }, 'Switches marked “uses system” follow the same function in every memory. To use this memory’s choice, set them to “Each memory” under ',
            h('a', { href: '#', onclick: function (e) { e.preventDefault(); go('system'); } }, 'System › Switch functions from'), '.') : null;
        })()
      ]),
      card('Assign 1–8', [h('p', { class: 'info' }, 'Extra controls: when something happens (a switch, a pedal, a MIDI CC…), change a function or setting.'),
        h('div', { class: 'assigns' }, assigns)], 'wide')
    )];
  }

  function assignRow(a) {
    var sec = 'ASSIGN' + a;
    var on = mget(sec, 'Sw'), tgt = mget(sec, 'Target');
    var rng = P.targetRange(tgt, { beat: beatIdx(), fxType: mget('LOOPFX', 'FxType') });
    function mm(key) {
      var f = M(sec, key);
      if (!rng) return null;
      if (rng.length > 300) return h('span', { class: 'ctl' }, num(f.v, 0, rng.length - 1, f.set), h('span', { class: 'note' }, rng[f.v] !== undefined ? '= ' + rng[f.v] : ''));
      return sel(rng, f.v, f.set);
    }
    return h('div', { class: 'arow' + (on ? '' : ' off') },
      h('label', { class: 'anum' }, h('input', { type: 'checkbox', checked: !!on, onchange: function (e) { mset(sec, 'Sw', e.target.checked ? 1 : 0); render(); } }), ' ' + a),
      h('div', { class: 'afield' }, h('span', { class: 'alabel' }, 'When'), sel(RCNames.options(L.assignSource, 'source'), mget(sec, 'Source'), function (v) { mset(sec, 'Source', v); render(); }),
        sel([[0, 'while held'], [1, 'on/off per press']], mget(sec, 'SourceMode'), function (v) { mset(sec, 'SourceMode', v); render(); })),
      h('div', { class: 'afield' }, h('span', { class: 'alabel' }, 'Does'), sel(RCNames.options(L.assignTarget, 'target'), tgt, function (v) {
        begin(); mset(sec, 'Target', v);
        var r = P.targetRange(v, { beat: beatIdx(), fxType: mget('LOOPFX', 'FxType') });
        mset(sec, 'TargetMin', 0); mset(sec, 'TargetMax', r ? r.length - 1 : 1);
        commit(); render();
      })),
      rng ? h('div', { class: 'afield' }, h('span', { class: 'alabel' }, 'From'), mm('TargetMin'), h('span', { class: 'alabel' }, 'to'), mm('TargetMax')) : null);
  }

  var RAW_SECTIONS = { TRACK1: 'Track 1', TRACK2: 'Track 2', MASTER: 'Record & play', LOOPFX: 'Loop FX', RHYTHM: 'Rhythm', CTL: 'Pedals & controllers',
    SETUP: 'General', PREF: 'Switch functions from', MIDI: 'MIDI', INPUT: 'Input / output', USB: 'USB' };
  var RAW_NAMES = { MeasMod: 'Loop length type', MeasLen: 'Loop length (measures)', MeasBtLp: 'Loop length (beats)', RecTmp: 'Recorded at tempo (×10)',
    WavStat: 'Has a recording (1 = yes)', WavLen: 'Recording length (samples)', CurrentTrack: 'Selected track (0 = 1, 1 = 2)',
    AllTrackSel: 'Both tracks selected', LpMod: 'Loop mode', TrkMod: 'Track mode', Sync: 'Sync',
    ScatterLength: 'Scatter: chop length', RepeatLength: 'Repeat: length', ShiftShift: 'Shift: shift by', VinylFlickFlick: 'Vinyl flick: amount' };
  /** Read-only view of everything stored for the selected memory and the system, for troubleshooting. */
  function storedValuesDialog() {
    function label(db, sec, key) { var l = covered[db][sec + '.' + key]; return typeof l === 'string' ? l : RAW_NAMES[key] || ''; }
    var lines = [];
    function block(db, b, title) {
      var out = [h('h3', null, title)];
      lines.push('== ' + title);
      b.sections.forEach(function (s) {
        if (s.name === 'NAME') return;
        lines.push('[' + s.name + '] ' + s.fields.map(function (f) { return f[0] + '=' + f[1]; }).join(' '));
        out.push(h('div', { class: 'rawsec' }, h('h4', null, (RAW_SECTIONS[s.name] || s.name.replace(/^ASSIGN/, 'Assign ')) + '  ', h('small', null, s.name)),
          h('div', { class: 'rawgrid ro' }, s.fields.map(function (f) {
            var l = label(db, s.name, f[0]);
            return h('div', { class: 'rawitem', title: s.name + ' › ' + f[0] }, h('span', null, l || f[0]), h('b', null, String(f[1])));
          }))));
      });
      return out;
    }
    var body = h('div', { class: 'stored' },
      h('p', { class: 'info' }, 'Everything the editor has loaded for memory ' + (S.cur + 1) + ' and the system settings, as the numbers stored in the pedal’s files. Read only – for troubleshooting. Use Copy to send it to me if something looks wrong.'),
      block('mem', S.mem.blocks[S.cur], 'Memory ' + (S.cur + 1) + ' – ' + RC0.memName(S.mem.blocks[S.cur]).trim()),
      block('sys', S.sys.blocks[0], 'System'));
    dialog('Stored values', body, [
      { label: 'Copy', onclick: function () { try { navigator.clipboard.writeText(lines.join('\n')).then(function () { toast('Copied'); }); } catch (e) { errToast(e); } return false; } },
      { label: 'Close', primary: true }]);
  }

  var taps = [];
  function tapTempo() {
    var now = performance.now();
    taps = taps.filter(function (t) { return now - t < 2500; }); taps.push(now);
    if (taps.length >= 2) {
      var avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      var bpm = Math.max(40, Math.min(300, 60000 / avg));
      mset('MASTER', 'Tempo', Math.round(bpm * 10)); render();
    }
  }

  function pageSystem() {
    var ext = [];
    for (var e = 1; e <= 5; e++) {
      (function (e) {
        var mn = Sy('SETUP', 'Extent' + e + 'Min'), mx = Sy('SETUP', 'Extent' + e + 'Max');
        ext.push(row('Range ' + e, [sel(L.extVal, mn.v, mn.set), ' – ', sel(L.extVal, mx.v, mx.set)]));
      })(e);
    }
    function sCtl(label, key, list) { var f = Sy('CTL', key); var r = row(label, sel(RCNames.options(list), f.v, f.set)); r.classList.add('stack'); return r; }
    return [h('div', { class: 'memhead' }, h('div', { class: 'memtitle' }, h('span', { class: 'big' }, 'SYSTEM')),
      h('div', { class: 'tools' }, h('button', { class: 'danger', onclick: resetSystem }, 'Initialize system'))),
    h('div', { class: 'grid' },
      card('General', [
        sSel('Display contrast', 'SETUP', 'Contrast', L.contrast),
        sSel('Display shows', 'SETUP', 'DisplayMode', L.dispMode, 'What the display shows while recording and playing.'),
        sSel('Undo/redo', 'SETUP', 'UndoRedo', L.undoRedo, 'For switches with “hold: undo”: undo while you’re still holding the switch, or when you let go.'),
        sSel('Current memory', 'SETUP', 'MemoryNumber', P.range(1, 99, pad2), 'The memory the pedal had selected when its settings were last saved.')
      ]),
      card('Switch functions from', [
        sSel('REC/PLAY switch', 'PREF', 'Pdl1', L.pref), sSel('STOP switch', 'PREF', 'Pdl2', L.pref), sSel('TRACK SELECT switch', 'PREF', 'Pdl3', L.pref),
        sSel('Footswitch CTL1', 'PREF', 'Ctl1', L.pref), sSel('Footswitch CTL2', 'PREF', 'Ctl2', L.pref), sSel('Expression pedal', 'PREF', 'Exp', L.pref),
        h('p', { class: 'info' }, 'Each memory: the switch does what the memory says (Memory page). System: the same function in every memory (below).')
      ]),
      card('Switch functions (system)', [
        sCtl('REC/PLAY switch', 'Pedal1', L.pdlCtl), sCtl('STOP switch', 'Pedal2', L.pdlCtl), sCtl('TRACK SELECT switch', 'Pedal3', L.pdlCtl),
        sCtl('Footswitch CTL1', 'Ctl1', L.pdlCtl), sCtl('Footswitch CTL2', 'Ctl2', L.pdlCtl), sCtl('Expression pedal', 'Exp', L.exp),
        h('p', { class: 'info' }, 'Used in every memory for the switches set to “System” above.')
      ]),
      card('MIDI', [
        sSel('Receive channel', 'MIDI', 'RxCtlCh', L.ch16, 'MIDI channel the pedal listens on for memory changes and CC messages. The editor sends on this channel.'),
        sChk('Listen on all channels', 'MIDI', 'Omni', 'OMNI: react to messages on every MIDI channel.'),
        sSel('Drum notes channel', 'MIDI', 'RxNoteCh', L.ch16, 'MIDI notes on this channel play the RC-500’s drum sounds.'),
        sSel('Send channel', 'MIDI', 'TxCh', L.txCh, 'Channel the pedal sends on.'),
        sSel('Follow tempo from', 'MIDI', 'Sync', L.syncClock, 'Auto follows MIDI clock from the MIDI IN jack or USB when there is one (needed for the editor’s tempo), otherwise the memory tempo.'),
        sChk('Send MIDI clock', 'MIDI', 'ClkOut', 'Send the tempo as MIDI clock (the editor shows it in Direct mode).'),
        sSel('MIDI start starts', 'MIDI', 'SyncStart', L.syncStart, 'What starts when a MIDI Start message arrives.'),
        sChk('Send memory changes', 'MIDI', 'PcOut', 'Send a program change when you change memory (the editor follows the pedal with it).'),
        sSel('Pass on MIDI IN to', 'MIDI', 'MidiThru', L.thru, 'Where messages arriving at MIDI IN are passed on.'),
        sSel('Pass on USB MIDI to', 'MIDI', 'UsbThru', L.thru, 'Where MIDI messages arriving over USB are passed on.')
      ]),
      card('Memory ranges', [h('p', { class: 'info' }, 'Limits which memories a footswitch set to “Next memory” or “Previous memory” steps through – for example a set list in memories 10–15, so you don’t have to step past the others. You can keep five ranges and switch between them with a switch set to “Next memory range”. The pedal calls this EXTENT.'), sSel('Range in use', 'SETUP', 'ExtentCh', L.extent), h('p', { class: 'info' }, 'First and last memory of each range:')].concat(ext)),
      card('Pedal data', [
        h('p', { class: 'info' }, 'Backups, other sources for the memories and a read-only view of the stored values.'),
        h('div', { class: 'datagrid' },
          h('button', { disabled: !S.store, onclick: function () { backup().catch(errToast); }, title: S.store ? 'Save all memories and settings as a ZIP file' : 'Load the memories from the pedal first' }, 'Back up the pedal’s data'),
          h('button', { onclick: openFolder, title: 'Load a backup ZIP, or a ROLAND folder copied from the pedal' }, 'Open a backup or folder…'),
          h('button', { onclick: openFactory, title: 'Begin from the pedal’s factory settings' }, 'Start from factory settings'),
          h('button', { onclick: storedValuesDialog, title: 'The raw numbers stored for the memory and the system' }, 'Show stored values'))
      ]),
      card('Input / output', [
        sChk('Phantom power', 'INPUT', 'Phantom', 'Power for condenser microphones on MIC IN.'),
        sSel('Mic goes to', 'INPUT', 'MicOut', L.micOut, 'Which outputs the live mic sound goes to.'),
        sSel('Instrument goes to', 'INPUT', 'InstOut', L.instOut, 'Which outputs the live instrument sound goes to.'),
        sSel('Rhythm goes to', 'INPUT', 'RhythmOut', L.rhyOut, 'Which outputs the rhythm goes to. “Into the loop” records the rhythm into the tracks instead.'),
        (function () { var f = Sy('INPUT', 'MicNs'); return row('Mic noise gate', slider(f.v, 0, 100, f.set), 'Noise suppressor on the mic while recording.'); })(),
        (function () { var f = Sy('INPUT', 'InstNs'); return row('Instrument noise gate', slider(f.v, 0, 100, f.set), 'Noise suppressor on the instrument inputs while recording.'); })(),
        sSel('INPUT light shows', 'INPUT', 'Indicator', L.peak, 'Which signal the INPUT level light follows.')
      ])),
    // On a phone the bottom tabs have no room for MIDI and Help, so they are here.
    h('div', { class: 'phoneonly datagrid' },
      h('button', { onclick: function () { go('remote'); } }, 'MIDI'),
      h('button', { onclick: function () { go('about'); } }, 'Help'))];
  }

  // ------------------------------------------------------------------ loops (WAV)
  function loopDir(i, t) { return 'WAVE/' + pad3(i + 1) + '_' + t; }
  // ------------------------------------------------------------------ loops: on the pedal's drive
  /** The drive the loops are read from: the one opened for the loops, else the one the memories came from. */
  function LS() { return S.loopStore || S.store; }
  // Android keeps showing a drive it has mounted even after the pedal has left storage mode, so there we also
  // ask the pedal: when it says it's in play mode, the drive isn't really there.
  function pedalSaysNoDrive() { return PF.isAndroid && S.midi.connected && S.midi.sysexOk && !S.storage; }
  async function driveReachable(view) { if (pedalSaysNoDrive()) return false; try { return !!view && (await Promise.race([view.list('DATA'), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 5000); })])).length > 0; } catch (e) { return false; } }

  /**
   * The loops live on the pedal's USB drive, so it has to be in storage mode. Stop the pedal, switch it to
   * storage mode and open the (remembered) drive – used when the Loops tab opens.
   */
  async function openLoopDrive() {
    if (S.loopBusy) return;
    if (LS() && LS().hasWave && await driveReachable(LS())) { if (!S.loops) { S.loops = null; render(); } return; }
    S.loopBusy = true;
    var b = busy('Stopping the pedal…');
    try {
      if (S.midi.connected) { midiSend([0xFC]); await PF.sleep(400); }      // stop everything first
      var view = await getDrive(b);
      if (!view.hasWave) throw new Error('No ROLAND/WAVE folder on this drive.');
      if (!S.store && !anyDirty()) { b.set('Reading the memories…'); await loadFrom(view); }
      S.loopStore = view; S.loops = null; S.loopDriveGone = false;
      b.close();
    } catch (e) { b.close(); if (e.name !== 'AbortError' && e.message !== 'Cancelled') errToast(e); }
    finally { S.loopBusy = false; render(); }
  }

  async function openLoopFolder() {
    try { var v = PF.Storage.canWriteDirect ? await PF.Storage.pick() : await pickViaInput(); S.loopStore = v; S.loops = null; S.loopDriveGone = false; render(); }
    catch (e) { if (e.name !== 'AbortError' && e.message !== 'Cancelled') errToast(e); }
  }

  async function scanLoops() {
    if (!LS() || !LS().hasWave) { S.loops = null; return; }
    var loops = {};
    var dirs = await LS().list('WAVE');
    var names = {}; dirs.forEach(function (d) { if (d.dir) names[d.name] = 1; });
    for (var i = 0; i < 99; i++) {
      loops[i] = {};
      for (var t = 1; t <= 2; t++) {
        var dn = pad3(i + 1) + '_' + t;
        if (!names[dn]) continue;
        var files = (await LS().list('WAVE/' + dn)).filter(function (f) { return !f.dir && /\.wav$/i.test(f.name) && f.name[0] !== '.'; });
        if (files.length) {
          var size = await LS().size('WAVE/' + dn + '/' + files[0].name);
          loops[i][t] = { name: files[0].name, size: size };
        }
      }
    }
    S.loops = loops;
  }

  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' kB'; }

  function pageLoops() {
    var auto = canAutoStorage() || (PF.isAndroid && S.storage);
    if (!LS() || !LS().hasWave || S.loopDriveGone) {
      if (PF.isAndroid && !S.storage) return androidStorageHelp();
      if (auto && !S.loopTried) { S.loopTried = true; S.loopDriveGone = false; setTimeout(openLoopDrive, 0); }
      return h('div', { class: 'empty' }, h('h2', null, 'Loops'),
        h('p', null, 'The recorded loops are on the pedal’s USB drive. To read them, the pedal stops and switches to storage mode – it can’t play while you work here.'),
        h('p', null, 'When you are done, eject the drive and choose Leave storage mode (Start page, Direct or the MIDI page) so the pedal can play again.'),
        h('p', null,
          auto ? h('button', { class: 'primary', disabled: !!S.loopBusy, onclick: function () { S.loopDriveGone = false; openLoopDrive(); } }, 'Read the loops from the pedal') : null, ' ',
          h('button', { onclick: openLoopFolder }, auto ? 'Open a folder instead…' : 'Open the pedal drive or ROLAND folder…')),
        !auto ? h('p', { class: 'info' }, S.midi.connected ? 'Put the pedal in storage mode first: MENU › STORAGE › CONNECTING.' : 'Connect the pedal, or put it in storage mode on the pedal: MENU › STORAGE › CONNECTING.') : null);
    }
    if (!S.loops) { scanLoops().then(render, errToast); return h('div', { class: 'empty' }, h('p', null, 'Scanning ROLAND/WAVE…')); }
    var onlyUsed = !!S.loopsOnlyUsed;
    var rows = [];
    for (var i = 0; i < 99; i++) {
      var l = S.loops[i] || {};
      if (onlyUsed && !l[1] && !l[2] && i !== S.cur) continue;
      rows.push(h('tr', { class: i === S.cur ? 'sel' : '' },
        h('td', { class: 'no', onclick: (function (i) { return function () { S.cur = i; render(); }; })(i) }, pad2(i + 1)),
        h('td', { class: 'nm' }, RC0.memName(blk(i)).trim()),
        [1, 2].map(function (t) { return h('td', null, loopCell(i, t, l[t])); })));
    }
    return [h('div', { class: 'memhead' }, h('div', { class: 'memtitle' }, h('span', { class: 'big' }, 'LOOPS')),
      h('div', { class: 'tools' },
        h('label', { class: 'inl' }, h('input', { type: 'checkbox', checked: onlyUsed, onchange: function (e) { S.loopsOnlyUsed = e.target.checked; render(); } }), ' Only memories with loops'),
        h('button', { onclick: function () { S.loops = null; render(); } }, '↻ Rescan'),
        LS().writable ? h('button', { onclick: function () { importSetDialog().catch(errToast); } }, '⬆ Import a set…') : null,
        h('button', { onclick: function () { exportAllLoops().catch(errToast); } }, '⬇ Export all…'),
        LS().writable ? h('button', { class: 'danger', onclick: deleteAllLoops }, 'Delete all…') : null)),
    h('p', { class: 'info' }, 'Imported audio is converted to the RC-500 format (44.1 kHz, 32-bit float, stereo) and copied to ROLAND/WAVE/<memory>_<track>. ' +
      (LS().writable ? 'The pedal picks up the new phrase when you leave storage mode.' : 'Read-only folder: imports are downloaded, copy them into the folder shown.')),
    h('table', { class: 'loops' }, h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Memory'), h('th', null, 'Track 1'), h('th', null, 'Track 2'))), h('tbody', null, rows))];
  }

  function loopCell(i, t, f) {
    var tempo = RC0.get(blk(i), 'MASTER', 'Tempo') / 10;
    if (f && !f.secs) {
      var wl = RC0.get(blk(i), 'TRACK' + t, 'WavLen');
      f.secs = RC0.get(blk(i), 'TRACK' + t, 'WavStat') && wl > 0 ? wl / 44100 : Math.max(0, f.size - 64) / 8 / 44100;
    }
    var bt = P.beatOf(RC0.get(blk(i), 'RHYTHM', 'Beat'));
    var playing = S.player && S.player.key === i + '_' + t;
    return h('div', { class: 'loopcell' },
      f ? h('span', { class: 'fname', title: f.name + ' — ' + fmtSize(f.size) }, f.name.replace(/\.wav$/i, ''), h('small', null, ' ' + fmtSize(f.size) +
        (f.secs ? ' · ' + f.secs.toFixed(1) + ' s ≈ ' + (f.secs * tempo / 60 / (bt[0] * 4 / bt[1])).toFixed(1) + ' meas' : ''))) : h('span', { class: 'empty-l' }, '—'),
      f ? h('button', { class: 'small' + (playing ? ' playing' : ''), title: playing ? 'Stop' : 'Play', onclick: function () { playLoop(i, t, f); } }, playing ? '■' : '▶') : null,
      f ? h('button', { class: 'small', title: 'Export WAV', onclick: function () { exportLoop(i, t, f); } }, '⬇') : null,
      h('button', { class: 'small', title: 'Import audio (WAV, MP3, …) into this track', onclick: function () { importLoop(i, t); } }, '⬆'),
      f && LS().writable ? h('button', { class: 'small danger', title: 'Delete this phrase', onclick: function () { deleteLoop(i, t, f); } }, '✕') : null);
  }

  async function readLoopFile(path) {
    try {
      // A drive Android still shows after the pedal left storage mode can hang instead of failing: give up after 20 s.
      return await Promise.race([LS().read(path), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 20000); })]);
    }
    catch (e) {
      // The drive is gone (the pedal left storage mode, or was unplugged): offer to open it again.
      if (!(await driveReachable(LS()))) { S.loopDriveGone = true; S.loopTried = false; render(); throw new Error('The pedal’s drive isn’t available any more – it has left storage mode.'); }
      throw e;
    }
  }

  async function playLoop(i, t, f) {
    if (S.player) { var k = S.player.key; S.player.stop(); S.player = null; if (k === i + '_' + t) { render(); return; } }
    if (f.size > 150 * 1048576) throw new Error('Too large to preview here');
    toast('Loading ' + f.name + '…');
    var bytes = await readLoopFile(loopDir(i, t) + '/' + f.name);
    var AC = window.AudioContext || window.webkitAudioContext, ctx = new AC();
    var buf;
    try { buf = AU.wavToAudioBuffer(ctx, bytes); } catch (e) { buf = await ctx.decodeAudioData(bytes.buffer.slice(0)); }
    f.secs = buf.duration;
    var src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(ctx.destination); src.start();
    S.player = { key: i + '_' + t, stop: function () { try { src.stop(); } catch (e) { } ctx.close(); } };
    render();
  }
  async function exportLoop(i, t, f) {
    var bytes = await readLoopFile(loopDir(i, t) + '/' + f.name);
    var nm = RC0.memName(blk(i)).trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') || 'Memory';
    await PF.saveFile('RC500_' + pad2(i + 1) + '_' + nm + '_T' + t + '.wav', bytes, 'audio/wav');
  }
  function pickFile(accept) {
    return new Promise(function (res) {
      var inp = h('input', { type: 'file', accept: accept, style: 'display:none' });
      inp.addEventListener('change', function () { res(inp.files[0] || null); inp.remove(); });
      document.body.appendChild(inp); inp.click();
    });
  }
  async function importLoop(i, t) {
    var file = await pickFile('audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac');
    if (!file) return;
    toast('Converting ' + file.name + '…');
    var buf = await AU.decodeAny(new Uint8Array(await file.arrayBuffer()));
    if (buf.duration < 0.35) throw new Error('The RC-500 needs at least 0.35 seconds of audio');
    var wav = AU.encodeRc500Wav(buf);
    // Name it the way the pedal names its own recordings: WAVE/001_1/001_1.WAV
    var name = loopDir(i, t).split('/').pop() + '.WAV';
    if (!LS().writable) {
      await PF.saveFile(name, wav, 'audio/wav');
      dialog('Copy the file to the pedal', h('div', null,
        h('p', null, 'This folder was opened read-only, so the converted file was downloaded instead.'),
        h('p', null, 'Copy ', h('b', null, name), ' into ', h('code', null, 'ROLAND/' + loopDir(i, t) + '/'), ' on the BOSS RC-500 drive, and delete any other WAV file in that folder.')));
      return;
    }
    var old = S.loops && S.loops[i] && S.loops[i][t];
    var go = async function () {
      var existing = (await LS().list(loopDir(i, t))).filter(function (f) { return !f.dir && /\.wav$/i.test(f.name); });
      S.driveWritten = true;
      for (var k = 0; k < existing.length; k++) await LS().remove(loopDir(i, t) + '/' + existing[k].name);
      await LS().write(loopDir(i, t) + '/' + name, wav);
      S.loops[i] = S.loops[i] || {}; S.loops[i][t] = { name: name, size: wav.length, secs: buf.duration };
      setPhraseInfo(i, t, buf.length);
      render();
      savePhraseInfo('Imported into memory ' + (i + 1) + ', track ' + t + '.');
    };
    if (old) dialog('Replace phrase?', h('p', null, 'Memory ' + (i + 1) + ' track ' + t + ' already has ' + old.name + '. Replace it?'),
      [{ label: 'Cancel' }, { label: 'Replace', danger: true, onclick: go }]);
    else await go();
  }
  /** The memory itself records whether a track has a phrase and how long it is (in samples); the pedal
      reports "data damaged" when that doesn't match the WAV file, so keep it in step. */
  function setPhraseInfo(i, t, frames) {
    begin();
    mset('TRACK' + t, 'WavStat', frames ? 1 : 0, i);
    mset('TRACK' + t, 'WavLen', frames, i);
    commit();
  }
  function savePhraseInfo(what) {
    dialog('Save the memory too', h('div', null,
      h('p', null, what + ' The memory on the pedal must be updated as well (it stores whether the track has a phrase and how long it is) – otherwise the pedal reports “data damaged”.'),
      h('p', { class: 'info' }, 'Save now, or later with Save to pedal.')),
      [{ label: 'Later' }, { label: 'Save now', primary: true, onclick: function () { setTimeout(function () { save().catch(errToast); }, 0); } }]);
  }
  // ------------------------------------------------------------------ loops in bulk
  function pickFiles(folder) {
    return new Promise(function (res) {
      var a = { type: 'file', multiple: true, accept: 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac', style: 'display:none' };
      if (folder) a.webkitdirectory = true;
      var inp = h('input', a);
      inp.addEventListener('change', function () { res(Array.prototype.slice.call(inp.files)); inp.remove(); });
      document.body.appendChild(inp); inp.click();
    });
  }
  function isAudioName(n) { return /\.(wav|mp3|m4a|aac|ogg|oga|flac|aif|aiff)$/i.test(n) && n[0] !== '.'; }
  /** "001_2 Pop06 (BPM108).wav" (from Export all) -> "Pop06 (BPM108)" */
  function loopTitle(n) { return n.replace(/\.[^.]+$/, '').replace(/^\d{3}_[12] /, ''); }
  function bpmOf(n) { var m = /BPM\s*(\d{2,3}(?:\.\d)?)/i.exec(n); return m ? +m[1] : 0; }
  function freeSlots() {
    var out = [];
    for (var i = 0; i < 99; i++) for (var t = 1; t <= 2; t++) if (!(S.loops && S.loops[i] && S.loops[i][t])) out.push([i, t]);
    return out;
  }

  /** Import many audio files at once into free tracks (e.g. loops saved earlier with Export all). */
  async function importSetDialog() {
    if (!S.loops) await scanLoops();
    var files = [];
    var count = h('p', { class: 'info' }, 'No files chosen yet.');
    var startSel = h('select', null, Array.apply(null, { length: 99 }).map(function (_, i) { return h('option', { value: i }, pad2(i + 1) + ' ' + RC0.memName(blk(i)).trim()); }));
    var firstFree = freeSlots()[0]; startSel.value = firstFree ? firstFree[0] : 0;
    var mode = h('select', null, h('option', { value: 'one' }, 'One loop per memory (track 1)'), h('option', { value: 'both' }, 'Fill track 1 and track 2'));
    var nameCb = h('input', { type: 'checkbox', checked: true }), tempoCb = h('input', { type: 'checkbox', checked: true });
    function setFiles(list) {
      files = list.filter(function (f) { return isAudioName(f.name); })
        .sort(function (a, b) { return (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }); });
      count.textContent = files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') + ': ' + files.slice(0, 4).map(function (f) { return loopTitle(f.name); }).join(', ') + (files.length > 4 ? ' …' : '') : 'No audio files found.';
    }
    dialog('Import a set of loops', h('div', null,
      h('p', null, 'Choose a folder or several audio files. They go into the free tracks in name order, starting at the memory you pick; tracks that already have a phrase are skipped.'),
      h('div', { class: 'btnrow' },
        h('button', { onclick: function () { pickFiles(true).then(setFiles); } }, 'Choose a folder…'),
        h('button', { onclick: function () { pickFiles(false).then(setFiles); } }, 'Choose files…')),
      count,
      h('div', { class: 'rangein' }, 'Start at memory ', startSel),
      h('div', { class: 'rangein' }, mode),
      h('label', { class: 'inl' }, nameCb, ' Name the memories after the files (12 characters)'), h('br'),
      h('label', { class: 'inl' }, tempoCb, ' Set the memory tempo from “BPM…” in the file name'),
      h('p', { class: 'info' }, 'WAV files already in the RC-500 format (44.1 kHz, 32-bit float, stereo) are copied unchanged; other audio is converted. Save to pedal afterwards to update the memories.')),
      [{ label: 'Cancel' }, {
        label: 'Import', primary: true, onclick: function () {
          if (!files.length) { toast('Choose a folder or files first', 'err'); return false; }
          importSet(files, +startSel.value, mode.value, nameCb.checked, tempoCb.checked).catch(errToast);
        }
      }]);
  }

  async function importSet(files, start, mode, names, tempos) {
    var slots = freeSlots().filter(function (s) { return s[0] >= start && (mode === 'both' || s[1] === 1); });
    if (mode === 'one') slots = slots.filter(function (s) { return !(S.loops[s[0]] && S.loops[s[0]][2]); });
    var n = Math.min(files.length, slots.length);
    if (!n) throw new Error('There are no free tracks from memory ' + (start + 1) + ' on.');
    var b = busy('Importing…'), done = 0, named = {};
    S.driveWritten = true;
    begin();
    try {
      for (var k = 0; k < n; k++) {
        var f = files[k], i = slots[k][0], t = slots[k][1], title = loopTitle(f.name);
        b.set('Importing ' + (k + 1) + ' of ' + n + ': ' + title);
        var bytes = new Uint8Array(await f.arrayBuffer()), wav = null, frames = 0;
        try { var w = AU.wavInfo(bytes); if (w.format === 3 && w.bits === 32 && w.channels === 2 && w.rate === 44100) { wav = bytes; frames = w.frames; } } catch (e) { }
        if (!wav) {
          var buf = await AU.decodeAny(bytes);
          if (buf.duration < 0.35) continue;
          wav = AU.encodeRc500Wav(buf); frames = buf.length;
        }
        var fname = (title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || loopDir(i, t).split('/').pop()) + '.wav';
        var existing = (await LS().list(loopDir(i, t))).filter(function (x) { return !x.dir && /\.wav$/i.test(x.name); });
        for (var e = 0; e < existing.length; e++) await LS().remove(loopDir(i, t) + '/' + existing[e].name);
        await LS().write(loopDir(i, t) + '/' + fname, wav);
        S.loops[i] = S.loops[i] || {}; S.loops[i][t] = { name: fname, size: wav.length, secs: frames / 44100 };
        mset('TRACK' + t, 'WavStat', 1, i); mset('TRACK' + t, 'WavLen', frames, i);
        if (names && !named[i]) {
          named[i] = true;
          var v = title.replace(/\s*\(BPM[^)]*\)/i, '').slice(0, 12);
          for (var c = 0; c < 12; c++) { var cc = c < v.length ? v.charCodeAt(c) : 32; if (cc < 32 || cc > 126) cc = 95; mset('NAME', 'C' + pad2(c + 1), cc, i); }
        }
        var bpm = bpmOf(f.name);
        if (tempos && bpm >= 40 && bpm <= 250) {
          mset('TRACK' + t, 'RecTmp', Math.round(bpm * 10), i);
          if (t === 1) mset('MASTER', 'Tempo', Math.round(bpm * 10), i);
        }
        done++;
      }
    } finally { commit(); b.close(); render(); }
    var left = files.length - n;
    savePhraseInfo('Imported ' + done + ' loop' + (done === 1 ? '' : 's') + (left > 0 ? ' – ' + left + ' did not fit (no free tracks left)' : '') + '.');
  }

  /** Save every phrase to a folder (Chrome/Edge) or a ZIP file, named "001_1 <name>.wav". */
  async function exportAllLoops() {
    if (!S.loops) await scanLoops();
    var list = [];
    for (var i = 0; i < 99; i++) for (var t = 1; t <= 2; t++) if (S.loops[i] && S.loops[i][t]) list.push([i, t, S.loops[i][t]]);
    if (!list.length) { toast('There are no loops to export'); return; }
    function outName(x) { return pad3(x[0] + 1) + '_' + x[1] + ' ' + x[2].name.replace(/\.wav$/i, '') + '.wav'; }
    if (typeof window.showDirectoryPicker === 'function') {
      var dir = await window.showDirectoryPicker({ id: 'rc500-loops', mode: 'readwrite' });
      var b = busy('Exporting…');
      try {
        for (var k = 0; k < list.length; k++) {
          b.set('Exporting ' + (k + 1) + ' of ' + list.length + '…');
          var bytes = await readLoopFile(loopDir(list[k][0], list[k][1]) + '/' + list[k][2].name);
          var fh = await dir.getFileHandle(outName(list[k]).replace(/[\\/:*?"<>|]+/g, '_'), { create: true });
          var w = await fh.createWritable(); await w.write(bytes); await w.close();
        }
      } finally { b.close(); }
      toast('Exported ' + list.length + ' loops to “' + dir.name + '”');
      return;
    }
    var total = list.reduce(function (a, x) { return a + x[2].size; }, 0);
    if (total > 700 * 1048576) throw new Error('That is ' + Math.round(total / 1048576) + ' MB – too much for one ZIP in this browser. Use Chrome or Edge, which save straight to a folder.');
    var b2 = busy('Collecting the loops…'), files = [];
    try {
      for (var q = 0; q < list.length; q++) { b2.set('Reading ' + (q + 1) + ' of ' + list.length + '…'); files.push({ name: outName(list[q]), data: await readLoopFile(loopDir(list[q][0], list[q][1]) + '/' + list[q][2].name) }); }
    } finally { b2.close(); }
    await PF.saveFile('rc500-loops.zip', AU.zip(files), 'application/zip');
  }

  /** Delete every phrase on the pedal (e.g. to make room for new loops). */
  function deleteAllLoops() {
    var list = [];
    for (var i = 0; i < 99; i++) for (var t = 1; t <= 2; t++) if (S.loops && S.loops[i] && S.loops[i][t]) list.push([i, t]);
    if (!list.length) { toast('There are no loops to delete'); return; }
    dialog('Delete all loops?', h('div', null,
      h('p', null, 'Delete all ' + list.length + ' phrases on the pedal? This cannot be undone – export the ones you want to keep first.'),
      h('p', { class: 'info' }, 'The memories are updated to match; save them to the pedal afterwards.')),
      [{ label: 'Cancel' }, {
        label: 'Delete ' + list.length + ' phrases', danger: true, onclick: async function () {
          var b = busy('Deleting…');
          try {
            S.driveWritten = true;
            // Start from the memories as they are on the pedal now (another program may have changed them).
            var view = LS();
            if (!anyDirty()) {
              b.set('Reading the memories…');
              try { await loadFrom(view); } catch (e) { }
              S.loopStore = view; S.loopDriveGone = false;
            }
            begin();
            for (var k = 0; k < list.length; k++) {
              var i = list[k][0], t = list[k][1], dir = loopDir(i, t);
              b.set('Deleting ' + (k + 1) + ' of ' + list.length + '…');
              var files = (await LS().list(dir)).filter(function (f) { return !f.dir && /\.wav$/i.test(f.name); });
              for (var n = 0; n < files.length; n++) await LS().remove(dir + '/' + files[n].name);
              mset('TRACK' + t, 'WavStat', 0, i); mset('TRACK' + t, 'WavLen', 0, i);
            }
            commit();
            S.loops = null; b.close(); render();
            savePhraseInfo('Deleted ' + list.length + ' phrases.');
          } catch (e) { commit(); b.close(); S.loops = null; render(); errToast(e); }
        }
      }]);
  }
  function deleteLoop(i, t, f) {
    dialog('Delete phrase?', h('p', null, 'Delete ' + f.name + ' from memory ' + (i + 1) + ', track ' + t + '? This cannot be undone.'),
      [{ label: 'Cancel' }, {
        label: 'Delete', danger: true, onclick: async function () {
          S.driveWritten = true;
          await LS().remove(loopDir(i, t) + '/' + f.name); delete S.loops[i][t];
          setPhraseInfo(i, t, 0); render();
          savePhraseInfo('Deleted.');
        }
      }]);
  }

  // ------------------------------------------------------------------ remote (MIDI)
  var markNo = 0, lastLog = 0;
  function logMidi(dir, m, text) {
    var now = performance.now();
    // Automatic divider when the messages pause, so each press on the pedal shows up as its own block.
    if (dir !== 'mark' && lastLog && now - lastLog > 500 && S.midiLog.length && S.midiLog[0].dir !== 'mark') {
      markNo++; S.midiLog.unshift({ dir: 'mark', text: '──── ' + markNo + ' (+' + ((now - lastLog) / 1000).toFixed(1) + ' s) ────' });
    }
    if (dir !== 'mark') lastLog = now;
    var d = new Date();
    var ts = pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 2);
    S.midiLog.unshift({ dir: dir, text: ts + '  ' + (text || describe(m)) });
    if (S.midiLog.length > 200) S.midiLog.pop();
    renderMidiLog();
  }
  function renderMidiLog() {
    var el = $('midilog'); if (!el) return;
    el.innerHTML = '';
    S.midiLog.forEach(function (l) { el.appendChild(h('div', { class: l.dir }, l.dir === 'mark' ? l.text : (l.dir === 'in' ? '← ' : '→ ') + l.text)); });
  }
  function describe(m) {
    var s = m[0], t = s & 0xF0, ch = (s & 15) + 1;
    if (t === 0xC0) return 'Program change ' + (m[1] + 1) + ' (ch ' + ch + ')';
    if (t === 0xB0) return 'CC#' + m[1] + ' = ' + m[2] + ' (ch ' + ch + ')';
    if (t === 0x90) return 'Note on ' + m[1] + ' vel ' + m[2] + ' (ch ' + ch + ')';
    if (t === 0x80) return 'Note off ' + m[1] + ' (ch ' + ch + ')';
    if (s === 0xFA) return 'Start'; if (s === 0xFC) return 'Stop'; if (s === 0xFB) return 'Continue';
    if (s === 0xF0) {
      var e = PF.SYSEX.editMode(m); if (e >= 0) return 'Storage mode: ' + ['off', 'on', 'busy'][e];
      if (m[1] === 0x7E && m[3] === 0x06 && m[4] === 0x01) return 'Identity request (hello)';
      if (m[1] === 0x7E && m[3] === 0x06 && m[4] === 0x02) return 'Identity reply: ' + PF.hex(m);
      if (m[1] === 0x41 && m[7] === 0x11) return 'Ask storage mode: ' + PF.hex(m);
      if (m[1] === 0x41 && m[7] === 0x12 && m[8] === 0x7F && m[9] === 0x70 && m.length === 15) return 'Set storage mode ' + (m[12] ? 'ON' : 'OFF') + ': ' + PF.hex(m);
      if (m.length === 13 && m[1] === 0x41 && m[3] === 0 && m[4] === 0 && m[5] === 0x72 && m[6] === 0x12)
        return 'Pedal status ' + PF.hex([m[7], m[8], m[9]]) + ' = ' + PF.hex([m[10]]) + ' (bits ' + ('0000000' + m[10].toString(2)).slice(-8) + ')';
    }
    return PF.hex(m);
  }
  function midiSend(bytes) {
    try { S.midi.send(bytes); if (bytes[0] !== 0xF8) logMidi('out', bytes); } catch (e) { errToast(e); }
  }

  var connecting = false;
  async function connectMidi() {
    if (connecting) return;                                   // a second click while connecting does nothing
    if (S.midi.connected) { toast('Already connected to ' + S.midi.name); return; }
    connecting = true;
    try {
      await S.midi.connect();
      toast('Connected to ' + S.midi.name);
      afterConnect();
      if (!S.midi.sysexOk) toast('SysEx was not allowed: storage mode switching is unavailable', 'err');
    } catch (e) { errToast(e); }
    finally { connecting = false; }
    render();
  }

  S.midi.onOut = function (b) { logMidi('out', b); };
  S.midi.onMessage(function (m) {
    if (m === null) { toast('MIDI device disconnected', 'err'); render(); return; }
    if (m === 'reconnected') { toast('Reconnected to ' + S.midi.name); logMidi('mark', null, '──── reconnected ────'); render(); return; }
    if (window.RCDirect) RCDirect.onMidi(m);
    if (m.length === 1 && m[0] >= 0xF8 && m[0] !== 0xFA && m[0] !== 0xFC) return; // clock etc.
    logMidi('in', m);
    if ((m[0] & 0xF0) === 0xC0 && S.followPedal && S.mem && m[1] < 99) { selectMemory(m[1], true); }
  });

  // Only one storage-mode change at a time: repeated requests while the pedal is mounting or
  // unmounting its drive can upset it (and the file system on it).
  var storageLock = false;
  async function withStorageLock(fn) {
    if (storageLock) { toast('The pedal is already switching storage mode – wait a moment', 'err'); return; }
    storageLock = true;
    try { return await fn(); } finally { storageLock = false; }
  }

  /** On a computer the drive must be ejected before the pedal leaves storage mode, or the file system can be damaged. */
  function confirmEjected(intro) {
    // Only writes leave the drive needing a proper eject (Windows marks it dirty); after just reading, leaving is safe.
    // Android doesn't notice the pedal leaving storage mode either, so it needs the same care.
    if (!S.storage || (!S.driveWritten && !PF.isAndroid)) return Promise.resolve(true);
    return new Promise(function (res) {
      dialog('Eject the drive first', h('div', null,
        intro ? h('p', null, intro) : null,
        PF.isAndroid
          ? h('p', null, 'Before the pedal goes back to play mode (or you pull the cable), eject its drive on the phone: open My Files (Mina filer) and tap ⏏ next to USB storage. Otherwise Android keeps a drive that isn’t there, and can complain or ask to restart.')
          : h('p', null, 'Before the pedal goes back to play mode, eject the “BOSS RC-500” drive on the computer, so nothing is half-written when it disappears:'),
        PF.isAndroid ? null : h('ul', null,
          h('li', null, 'Windows: the USB icon by the clock (or File Explorer › right-click the drive) › Eject.'),
          h('li', null, 'Mac: drag the drive to the Trash, or Eject in Finder.')),
        h('p', { class: 'info' }, PF.isAndroid ? 'To get to the loops again later, unplug the cable, start storage mode on the pedal and plug it back in.' : 'Wait until the computer says it is safe to remove it.')),
        [{ label: 'Later', onclick: function () { res(false); } }, { label: PF.isAndroid ? 'Drive is ejected' : 'Drive is ejected', primary: true, onclick: function () { res(true); } }]);
    });
  }

  async function storageMode(on) {
    if (!S.midi.connected) { await connectMidi(); if (!S.midi.connected) return; }
    if (!on) return leaveStorage();
    return withStorageLock(async function () {
      toast('Asking the pedal for storage mode…');
      try {
        var res = await S.midi.setEditMode(true, 20000);
        if (!res.ok && res.last === 2) { S.storage = true; S.autoStorage = true; toast('The pedal is switching to storage mode — the “BOSS RC-500” drive should appear shortly'); render(); return; }
        if (!res.ok) throw new Error(res.last === 2 ? 'The pedal keeps answering “busy”. Make sure it is stopped and on its play screen, or use MENU › STORAGE on the pedal.'
          : res.last === -1 ? 'The pedal did not answer. Check the USB cable, or use MENU › STORAGE on the pedal.'
          : 'The pedal did not switch. Try again, or use MENU › STORAGE on the pedal.');
        S.storage = true;
        toast('Storage mode on — the “BOSS RC-500” drive appears in a few seconds');
      } catch (e) { errToast(e); }
      render();
    });
  }

  function pageRemote() {
    var ch = rxCh();
    var connected = S.midi.connected;
    var ccRows = [];
    for (var a = 1; a <= 8; a++) {
      var src = mget('ASSIGN' + a, 'Source');
      if (src < 12) continue;
      var name = L.assignSource[src], cc = +name.slice(3);
      var target = L.assignTarget[mget('ASSIGN' + a, 'Target')];
      ccRows.push(ccPad(cc, RCNames.plain(target) + (mget('ASSIGN' + a, 'Sw') ? '' : ' (assign off)'), mget('ASSIGN' + a, 'SourceMode')));
    }
    return [h('div', { class: 'memhead' }, h('div', { class: 'memtitle' }, h('span', { class: 'big' }, 'MIDI')),
      h('div', { class: 'tools' }, connected
        ? h('button', { onclick: function () { S.midi.disconnect(); render(); } }, 'Disconnect')
        : h('button', { class: 'primary', onclick: connectMidi }, 'Connect over USB MIDI'))),
    !S.midi.available() ? h('p', { class: 'warn' }, 'This browser has no Web MIDI. Use Firefox or Chrome/Edge on an https page, or the Android app.') : null,
    h('p', { class: 'info lead' }, 'Lower-level control of the pedal over USB MIDI. To play the pedal, ', h('a', { href: '#', onclick: function (e) { e.preventDefault(); go('direct'); } }, 'Direct'),
      ' is easier. Here you can switch the USB drive on and off, change memory, start and stop, try the MIDI controls a memory listens to, and see every message going to and from the pedal.'),
    h('div', { class: 'grid' },
      card('Storage mode (USB drive)', [
        h('p', { class: 'info' }, 'Turns the pedal’s USB port into a drive so its memories and loops can be read and written – like MENU › STORAGE on the pedal. Load from pedal and Save to pedal do this for you. The pedal must be stopped.'),
        h('div', { class: 'btnrow' },
          h('button', { class: 'primary', disabled: !S.midi.available(), onclick: function () { storageMode(true); } }, 'Enter storage mode'),
          h('button', { disabled: !S.midi.available(), onclick: function () { storageMode(false); } }, 'Leave storage mode'))
      ]),
      card('Memory, start and stop', [
        row('Channel', sel(L.ch16, ch, function (v) { sset('MIDI', 'RxCtlCh', v); render(); }), 'The channel the pedal listens on (System › MIDI › Receive channel).'),
        row('Memory', [h('button', { class: 'small', disabled: !connected, onclick: function () { selectMemory(Math.max(0, S.cur - 1)); midiSend([0xC0 | ch, S.cur]); } }, '◀'),
          h('span', { class: 'big2' }, pad2(S.cur + 1)),
          h('button', { class: 'small', disabled: !connected, onclick: function () { selectMemory(Math.min(98, S.cur + 1)); midiSend([0xC0 | ch, S.cur]); } }, '▶'),
          h('button', { disabled: !connected, onclick: function () { midiSend([0xC0 | ch, S.cur]); } }, 'Select on the pedal')]),
        row('Follow the pedal', chk(S.followPedal, function (v) { S.followPedal = !!v; }), 'When you change memory on the pedal, the editor shows the same memory (needs System › MIDI › Send memory changes).'),
        row('Change memory on the pedal', chk(S.sendPcOnSelect, function (v) { S.sendPcOnSelect = !!v; }), 'When you pick a memory in the editor, the pedal switches to it too.'),
        h('div', { class: 'btnrow' },
          h('button', { class: 'transport', disabled: !connected, onclick: function () { midiSend([0xFA]); } }, '▶ Start'),
          h('button', { class: 'transport', disabled: !connected, onclick: function () { midiSend([0xFC]); } }, '■ Stop')),
        h('p', { class: 'info' }, 'Start plays the tracks (which ones is set under Memory › MIDI start plays and System › MIDI start starts). Stop stops everything.')
      ]),
      card('MIDI controls in memory ' + (S.cur + 1), [h('p', { class: 'info' }, 'The pedal only reacts to a MIDI CC (controller number + value 0–127) if one of the memory’s Assign slots listens for it. These are the ones this memory has. The button sends 127 while pressed and 0 when you let go (or switches on/off for “on/off per press”); the slider sends its value while you drag.')].concat(ccRows.length ? ccRows : [h('p', { class: 'info' }, 'This memory has none yet. Set an Assign’s “When” to a MIDI CC (or use Set up memories… for Direct mode).')])),
      card('MIDI messages', [h('p', { class: 'info' }, 'Everything sent to (→) and received from (←) the pedal. Useful when something doesn’t work: press Copy and send me the text.'), h('div', { class: 'btnrow' },
        h('button', { class: 'small', onclick: function () { markNo++; logMidi('mark', null, '──── mark ' + markNo + ' ────'); }, title: 'Add a divider, to see which messages belong to which press' }, '＋ Mark'),
        h('button', { class: 'small', onclick: function () { S.midiLog = []; markNo = 0; lastLog = 0; renderMidiLog(); } }, 'Clear'),
        h('button', { class: 'small', onclick: function () {
          var txt = S.midiLog.slice().reverse().map(function (l) { return (l.dir === 'in' ? '<- ' : l.dir === 'out' ? '-> ' : '') + l.text; }).join('\n');
          try { navigator.clipboard.writeText(txt).then(function () { toast('Monitor copied — paste it in the chat'); }); } catch (e) { errToast(e); }
        }, title: 'Copy the log (oldest first) as text' }, 'Copy')),
        h('div', { id: 'midilog', class: 'midilog' })])
    )];
  }

  /** One MIDI control the memory listens to: what it does, a button and a value slider. */
  function ccPad(cc, label, mode) {
    var ch = rxCh(), connected = S.midi.connected;
    var state = S.ccToggle = S.ccToggle || {};
    var btn = h('button', { class: 'small pad' + (state[cc] ? ' on' : ''), disabled: !connected },
      mode === 1 ? (state[cc] ? 'On (127) – click for off' : 'Off (0) – click for on') : 'Press: 127, release: 0');
    if (mode === 1) btn.addEventListener('click', function () {
      state[cc] = !state[cc]; midiSend([0xB0 | ch, cc, state[cc] ? 127 : 0]);
      btn.classList.toggle('on', state[cc]); btn.textContent = state[cc] ? 'On (127) – click for off' : 'Off (0) – click for on';
    });
    else {
      btn.addEventListener('pointerdown', function () { midiSend([0xB0 | ch, cc, 127]); btn.classList.add('on'); });
      ['pointerup', 'pointerleave'].forEach(function (ev) { btn.addEventListener(ev, function () { if (btn.classList.contains('on')) { midiSend([0xB0 | ch, cc, 0]); btn.classList.remove('on'); } }); });
    }
    var val = h('span', { class: 'ccval' }, '–');
    var rng = h('input', { type: 'range', min: 0, max: 127, value: 0, disabled: !connected, title: 'Sends the value while you drag',
      oninput: function () { val.textContent = rng.value; midiSend([0xB0 | ch, cc, +rng.value]); } });
    return h('div', { class: 'ccpad' },
      h('div', { class: 'cchead' }, h('span', { class: 'ccn' }, 'CC#' + cc), h('b', null, label)),
      h('div', { class: 'ccctl' }, btn, h('label', { class: 'ccslider' }, h('span', { class: 'note' }, 'Value'), rng, val)));
  }

  function afterConnect() {
    // Is the pedal in storage mode right now?
    // First connection with nothing read yet: read the memories from the pedal right away.
    // (On the Loops tab, opening the drive for the loops reads them too.)
    var autoLoad = S.midi.sysexOk && !S.store && !anyDirty() && PF.Storage.canWriteDirect && S.page !== 'loops' && !S.autoLoaded;
    if (S.midi.sysexOk) S.midi.queryEditMode(800).then(function (v) {
      if (v >= 0) { S.storage = v === 1; if (S.storage) { S.driveWritten = true; S.loopTried = false; } /* unknown history: play safe */ refreshChrome(); if (S.page === 'start' || S.page === 'loops') render(); }
      // On Android the app doesn't switch storage mode itself: read only when the pedal came in storage mode.
      if (PF.isAndroid && v !== 1) autoLoad = false;
      if (autoLoad && !S.store) {
        S.autoLoaded = true;
        loadFromPedal();
      }
    });
    refreshChrome(); if (S.page === 'start' || S.page === 'direct' || S.page === 'remote' || S.page === 'loops') render();
  }

  // ------------------------------------------------------------------ Start page: guided setup with live status
  function pageStart() {
    var conn = S.midi.connected, mid = !!navigator.requestMIDIAccess || PF.isAndroid;
    var direct = PF.Storage.canWriteDirect, autoStorage = conn && S.midi.sysexOk && direct && !PF.isAndroid;
    function step(n, title, done, body) {
      return h('section', { class: 'card step' + (done ? ' done' : '') },
        h('div', { class: 'stephead' }, h('span', { class: 'stepno' }, done ? '✓' : String(n)), h('h3', null, title)), body);
    }
    var prepared = 0;
    if (S.origMem && window.RCDirect) for (var i = 0; i < 99; i++) if (RCDirect.isPrepared(i)) prepared++;

    return h('div', { class: 'start' },
      h('div', { class: 'hero' }, h('h2', null, 'RC-500 Editor'),
        h('p', null, 'Edit your RC-500’s memories, manage its loops and play it from the screen — through the pedal’s own USB port.')),
      step(1, 'Connect the pedal', conn, [
        conn ? h('p', { class: 'ok' }, 'Connected to ' + S.midi.name + (S.storage ? ' — the pedal is in storage mode.' : '.'))
          : h('ul', { class: 'checklist' },
            h('li', null, 'Power the RC-500 (adapter or batteries). It only switches on with a cable in ', h('b', null, 'OUTPUT A/MONO'), '.'),
            h('li', null, 'Connect its USB port with a cable that carries data' + (PF.isAndroid ? ' (USB-C/OTG on the phone).' : '.')),
            !PF.isAndroid ? h('li', null, /Firefox/.test(navigator.userAgent) ? 'Firefox asks to add a small “site permission” for MIDI — allow it, including SysEx.' : 'Your browser asks to allow MIDI devices — allow it.') : null),
        !mid ? h('p', { class: 'warn' }, 'This browser has no USB MIDI. Use Chrome, Edge or Firefox (or the Android app).') : null,
        !PF.isAndroid && !PF.Storage.canWriteDirect ? h('p', { class: 'info' }, 'Recommended: Chrome or Edge (or another Chromium-based browser such as Opera). They switch the pedal’s storage mode, read and save directly on the pedal; this browser can only read it, and you copy saved files over yourself.') : null,
        h('div', { class: 'btnrow' },
          conn ? h('button', { onclick: function () { S.midi.disconnect(); render(); } }, 'Disconnect')
            : h('button', { class: 'primary', disabled: !mid, onclick: connectMidi }, 'Connect'),
          S.storage ? h('button', { onclick: function () { leaveStorage().catch(errToast); } }, 'Leave storage mode') : null),
        conn ? null : h('p', { class: 'info' }, 'Once allowed, the editor connects by itself the next time.')
      ]),
      step(2, 'Load your memories', !!S.store, [
        S.store ? h('p', { class: 'ok' }, 'Loaded from the pedal' + (S.files ? ' (' + S.files.memName + ')' : '') + '.' + (S.store.writable ? '' : ' Read-only in this browser.'))
          : h('p', null, 'The editor shows factory settings until you load your pedal’s memories.'),
        h('p', { class: 'info' }, autoStorage
          ? 'The pedal is read through its USB drive (“storage mode”). The editor switches it on and off for you; the pedal must be stopped.'
          : conn && direct && !PF.isAndroid ? 'The pedal is read through its USB drive (“storage mode”).'
            : 'The pedal is read through its USB drive (“storage mode”). ' + MANUAL_STORAGE),
        h('div', { class: 'btnrow' },
          h('button', { class: S.store ? '' : 'primary', onclick: function () { loadFromPedal(); } }, S.store ? '⤓ Load again' : '⤓ Load from pedal'),
          !S.store ? h('button', { onclick: openFactory }, 'Work without the pedal') : null)
      ]),
      step(3, 'Edit and save', false, [
        h('p', null, 'Pick a memory in the list' + (window.innerWidth < 820 ? ' (tap the memory name at the top)' : '') + ' and change it on the ', link('memory', 'Memory'), ' page; pedal-wide settings are under ',
          link('system', 'System'), '. Changes stay in the editor until you save.'),
        h('p', { class: 'info' }, direct
          ? (autoStorage ? 'Save to pedal writes the changes and switches the pedal back to play mode. It keeps the previous version as a fallback.'
            : 'Save to pedal writes to the drive while the pedal is in storage mode. It keeps the previous version as a fallback.')
          : 'This browser can’t write to the drive: Save gives you the changed file to copy into ROLAND/DATA on the pedal. Chrome, Edge or the Android app save directly.'),
        h('div', { class: 'btnrow' }, h('button', { disabled: !S.store, onclick: function () { backup().catch(errToast); } }, '⬇ Make a backup'))
      ]),
      step(4, 'Play the pedal from the screen (optional)', prepared > 0 && conn, [
        h('p', null, 'The ', link('direct', 'Direct'), ' page is the pedal’s panel on screen. The RC-500 only listens to the screen through a memory’s ASSIGN slots, so prepare the memories you want to use once and save them to the pedal.'),
        h('p', { class: prepared ? 'ok' : 'info' }, S.store ? prepared + ' of 99 memories are prepared on the pedal.' : 'Load your memories first to see which are prepared.'),
        h('div', { class: 'btnrow' },
          h('button', { onclick: function () { go('direct'); setTimeout(function () { RCDirect.setup(); }, 50); } }, 'Prepare memories…'),
          h('button', { onclick: function () { go('direct'); } }, 'Open Direct'))
      ]),
      h('p', { class: 'info center' }, 'Not affiliated with BOSS/Roland. ', link('about', 'Help and details'), ' · ',
        h('a', { href: 'https://github.com/jonsolberg/rc500editor', target: '_blank', rel: 'noopener' }, 'Source'), ' · ',
        h('a', { href: 'https://ko-fi.com/jonsolberg', target: '_blank', rel: 'noopener' }, '❤️ Support me')));
  }
  function link(page, text) { return h('a', { href: '#', onclick: function (e) { e.preventDefault(); go(page); } }, text); }

  function pageAbout() {
    var fsa = typeof window.showDirectoryPicker === 'function';
    return h('div', { class: 'about' },
      h('h2', null, 'RC-500 Editor ' + VERSION),
      h('p', null, 'Edit every memory and system setting of the BOSS RC-500 Loop Station, manage its recorded loops and play it live – all through the pedal’s USB port.'),
      h('p', { class: 'info' }, 'Make a backup the first time you save to the pedal (System › Pedal data › Back up the pedal’s data).'),
      h('h3', null, 'Getting started'),
      h('ol', null,
        h('li', null, 'Power the RC-500 (adapter or batteries, with a cable in OUTPUT A/MONO — that jack is its power switch) and connect it with a USB cable that carries data (on a phone: USB-C/OTG).'),
        h('li', null, 'The editor connects over USB MIDI by itself. The first time, the browser asks for permission (allow MIDI/SysEx).'),
        h('li', null, 'Press ', h('b', null, '⤓ Load from pedal'), '. The editor switches the pedal to storage mode, reads its memories and remembers the drive. The first time you pick the BOSS RC-500 drive (or its ROLAND folder)', (fsa || PF.isAndroid ? '' : ' — in this browser you pick it each time'), '. If storage mode doesn’t start, use MENU › STORAGE › CONNECTING on the pedal. The pedal must be stopped.'),
        h('li', null, 'Edit, then press ', h('b', null, '⤒ Save to pedal'), '. ' + (fsa || PF.isAndroid
          ? 'The files are written straight to the pedal and checked, and the pedal is switched back so it reloads its memories.'
          : 'Your browser downloads the changed files — copy them into ROLAND/DATA on the drive, eject it and leave storage mode on the pedal.'))),
      h('p', null, 'The Start page shows where you are in these steps.'),
      h('h3', null, 'The pages'),
      h('dl', { class: 'helpdl' },
        h('dt', null, 'Start'), h('dd', null, 'The steps above, with what’s done and what’s next.'),
        h('dt', null, 'Direct'), h('dd', null, 'Play the pedal from its panel on screen. The panel stays grey until an RC-500 is connected. ',
          'The pedal only reacts to the screen through a memory’s Assign slots, so first use “Set up memories…” and save to the pedal. ',
          'Hold REC/PLAY to undo and STOP to clear (2 seconds). Tempo is sent as MIDI clock and needs no setup. ',
          'The pedal reports which tracks have a recording and when playback starts and stops; the other lights follow your presses (Reset lights, under the pedal, puts them right). ',
          'The track sliders set the levels on the pedal, but can’t follow the pedal’s own sliders – the RC-500 doesn’t send those over USB.'),
        h('dt', null, 'Memory'), h('dd', null, 'Everything in the memory picked in the list: tracks, recording, playback, loop FX, rhythm, what the switches and pedals do, and the eight Assign slots. Copy, paste, swap and presets are at the top (⋯ on a phone).'),
        h('dt', null, 'Loops'), h('dd', null, 'Which memories have recordings. Play them, save them as WAV, import any audio file or delete them – one by one, or all at once with Export all, Import a set and Delete all.'),
        h('dt', null, 'MIDI'), h('dd', null, 'Lower-level tools: storage mode on/off, change memory, start/stop, try the MIDI controls a memory listens to, and see every message to and from the pedal.'),
        h('dt', null, 'System'), h('dd', null, 'Settings for the whole pedal: display, MIDI, inputs and outputs, which switches use the same function in every memory, and memory ranges for stepping through a set list.')),
      h('h3', null, 'System › Pedal data'),
      h('ul', null,
        h('li', null, h('b', null, 'Back up the pedal’s data'), ' – all memories and settings as a ZIP file. Do this before you save the first time.'),
        h('li', null, h('b', null, 'Open a backup or folder'), ' – load a backup ZIP, or a ROLAND folder copied from the pedal.'),
        h('li', null, h('b', null, 'Start from factory settings'), ' – begin from the pedal’s defaults instead of your memories.'),
        h('li', null, h('b', null, 'Show stored values'), ' – the raw numbers stored for the memory and the system, read only, for troubleshooting.')),
      h('p', null, 'The button at the top right switches between automatic, light and dark theme. On a phone, MIDI and Help are at the bottom of the System page.'),
      PF.isAndroid ? h('h3', null, 'Android') : null,
      PF.isAndroid ? h('p', { class: 'warn' }, 'Note: mounting the pedal’s drive is buggy on Android. It only works reliably with the steps below, and sometimes needs a second try (or a phone restart). Direct mode and editing aren’t affected.') : null,
      PF.isAndroid ? h('p', null, 'Android only sees the pedal’s drive when the pedal is already in storage mode as the cable goes in, and it doesn’t notice the drive going away. So on Android the app doesn’t switch storage mode for you:') : null,
      PF.isAndroid ? h('ol', null, ANDROID_STEPS.map(function (t) { return h('li', null, t); }), h('li', null, ANDROID_EJECT)) : null,
      PF.isAndroid ? h('p', { class: 'info' }, 'If My Files says the drive has errors (after the cable was pulled without ejecting), connect the pedal to a computer in storage mode and let it scan and repair the drive.') : null,
      h('h3', null, 'Your browser'),
      h('ul', null,
        h('li', null, 'Write directly to the pedal: ', fsa || PF.isAndroid ? '✅' : '❌ (Firefox/Safari can only read the folder; saving downloads the files)'),
        h('li', null, 'USB MIDI (Direct, MIDI page, automatic storage mode): ', navigator.requestMIDIAccess || PF.isAndroid ? '✅' : '❌'),
        h('li', null, 'Secure page (needed for both): ', window.isSecureContext ? '✅' : '❌ open the https version')),
      h('p', { class: 'info' }, 'Recommended: Chrome or Edge on a computer (or another Chromium-based browser such as Opera), or the Android app – they do all of the above.'),
      h('h3', null, 'Good to know'),
      h('ul', null,
        h('li', null, 'Tap ⓘ next to a setting for an explanation. Changes stay in the editor until you save; ↶ and ↷ in the header undo and redo them.'),
        h('li', null, 'The editor never deletes the pedal’s files: it writes the older of the two copies the RC-500 keeps (MEMORY1/2.RC0, SYSTEM1/2.RC0) with a newer save counter, so the previous version stays as a fallback. It warns if the pedal has newer changes than the ones you loaded.'),
        h('li', null, 'Imported audio is converted to 44.1 kHz 32-bit float stereo WAV, which the RC-500 reads directly.')),
      h('h3', null, 'Credits & licence'),
      h('p', null, '© 2026 Jon Solberg. Free software under the GNU GPL v3 or later. ',
        h('a', { href: 'https://github.com/jonsolberg/rc500editor', target: '_blank', rel: 'noopener' }, 'Source code on GitHub'), ' · ',
        h('a', { href: 'https://jonsolberg.se:8080/', target: '_blank', rel: 'noopener' }, 'jonsolberg.se'), '.'),
      h('p', null, 'File format and parameter encoding were worked out by D. Fleury’s ',
        h('a', { href: 'https://github.com/dfleury2/boss-rc500-editor', target: '_blank', rel: 'noopener' }, 'boss-rc500-editor'), ' (MIT licence). Not affiliated with BOSS or Roland.'),
      h('p', null, h('a', { class: 'kofi', href: 'https://ko-fi.com/jonsolberg', target: '_blank', rel: 'noopener' }, '❤️ Support me on Ko-fi')));
  }

  // ------------------------------------------------------------------ memory tools
  function rangeInputs() {
    var from = h('input', { type: 'number', min: 1, max: 99, value: Math.min(99, S.cur + 2) });
    var to = h('input', { type: 'number', min: 1, max: 99, value: Math.min(99, S.cur + 2) });
    return { from: from, to: to, el: h('div', { class: 'rangein' }, 'Memories ', from, ' to ', to) };
  }
  var SECTION_GROUPS = [['Tracks', ['TRACK1', 'TRACK2']], ['Record & play', ['MASTER']], ['Loop FX', ['LOOPFX']], ['Rhythm', ['RHYTHM']],
    ['Pedals & controllers', ['CTL']], ['Assigns', ['ASSIGN1', 'ASSIGN2', 'ASSIGN3', 'ASSIGN4', 'ASSIGN5', 'ASSIGN6', 'ASSIGN7', 'ASSIGN8']], ['Name', ['NAME']]];
  function sectionChecks(defName) {
    var boxes = SECTION_GROUPS.map(function (g) {
      var c = h('input', { type: 'checkbox', checked: g[0] === 'Name' ? !!defName : true });
      return { c: c, secs: g[1], el: h('label', { class: 'inl' }, c, ' ' + g[0]) };
    });
    return { el: h('div', { class: 'checks' }, boxes.map(function (b) { return b.el; })), get: function () { var o = []; boxes.forEach(function (b) { if (b.c.checked) o = o.concat(b.secs); }); return o; } };
  }
  function copySectionsUndoable(fromSections, toIdx, names) {
    fromSections.forEach(function (s) {
      if (names.indexOf(s.name) < 0) return;
      s.fields.forEach(function (f) { mset(s.name, f[0], f[1], toIdx); });
    });
  }
  function copyDialog() {
    var r = rangeInputs(), sc = sectionChecks(false);
    dialog('Copy memory ' + (S.cur + 1), h('div', null, r.el, h('p', null, 'Parts to copy:'), sc.el), [{ label: 'Cancel' }, {
      label: 'Copy', primary: true, onclick: function () {
        var a = Math.max(1, Math.min(99, +r.from.value)) - 1, b = Math.max(1, Math.min(99, +r.to.value)) - 1;
        if (a > b) { var t = a; a = b; b = t; }
        var src = RC0.cloneSections(blk()), names = sc.get();
        begin(); for (var i = a; i <= b; i++) if (i !== S.cur) copySectionsUndoable(src, i, names); commit();
        toast('Copied to ' + (a + 1) + (b > a ? '–' + (b + 1) : '')); render();
      }
    }]);
  }
  function pasteDialog() {
    var sc = sectionChecks(false);
    dialog('Paste into memory ' + (S.cur + 1), h('div', null, h('p', null, 'Parts to paste:'), sc.el), [{ label: 'Cancel' }, {
      label: 'Paste', primary: true, onclick: function () { begin(); copySectionsUndoable(S.clip, S.cur, sc.get()); commit(); render(); }
    }]);
  }
  function swapDialog() {
    var n = h('input', { type: 'number', min: 1, max: 99, value: Math.min(99, S.cur + 2) });
    dialog('Swap memory ' + (S.cur + 1) + ' with…', h('div', null, h('p', null, 'Memory ', n),
      h('p', { class: 'info' }, 'Settings and names are swapped. Recorded loops are not moved — use the Loops page for that.')), [{ label: 'Cancel' }, {
      label: 'Swap', primary: true, onclick: function () {
        var j = Math.max(1, Math.min(99, +n.value)) - 1; if (j === S.cur) return;
        var a = RC0.cloneSections(blk()), b = RC0.cloneSections(blk(j)), all = a.map(function (s) { return s.name; });
        begin(); copySectionsUndoable(b, S.cur, all); copySectionsUndoable(a, j, all); commit(); render();
      }
    }]);
  }
  function resetMemory() {
    var sc = sectionChecks(false);
    dialog('Initialize memory ' + (S.cur + 1), h('div', null, h('p', null, 'Reset to the factory settings:'), sc.el), [{ label: 'Cancel' }, {
      label: 'Initialize', danger: true, onclick: function () {
        var f = RC0.factoryMemory().blocks[S.cur];
        begin(); copySectionsUndoable(RC0.cloneSections(f), S.cur, sc.get()); commit(); render();
      }
    }]);
  }
  function resetSystem() {
    dialog('Initialize system settings', h('p', null, 'Reset all SYSTEM settings to factory values? (Undo is available.)'), [{ label: 'Cancel' }, {
      label: 'Initialize', danger: true, onclick: function () {
        var f = RC0.factorySystem().blocks[0];
        begin(); f.sections.forEach(function (s) { s.fields.forEach(function (x) { if (s.name === 'SETUP' && x[0] === 'MemoryNumber') return; sset(s.name, x[0], x[1]); }); }); commit(); render();
      }
    }]);
  }
  async function exportPreset() {
    var b = blk(), name = RC0.memName(b).trim() || 'Memory' + (S.cur + 1);
    var obj = { app: 'bossrc500editor', format: 1, model: S.mem.name || 'RC-500', name: name, sections: {} };
    b.sections.forEach(function (s) { var o = {}; s.fields.forEach(function (f) { o[f[0]] = f[1]; }); obj.sections[s.name] = o; });
    await PF.saveFile(name.replace(/[^\w\- ]+/g, '_') + '.rc500.json', new TextEncoder().encode(JSON.stringify(obj, null, 1)), 'application/json');
  }
  async function importPreset() {
    var f = await pickFile('.json,application/json'); if (!f) return;
    var obj = JSON.parse(await f.text());
    var secs = obj.sections;
    if (!secs && obj.tracks) throw new Error('This looks like a preset from another editor; only bossrc500editor presets are supported.');
    if (!secs) throw new Error('Not an RC-500 editor preset');
    var sc = sectionChecks(true);
    dialog('Load preset “' + (obj.name || f.name) + '” into memory ' + (S.cur + 1), h('div', null, h('p', null, 'Parts to load:'), sc.el), [{ label: 'Cancel' }, {
      label: 'Load', primary: true, onclick: function () {
        var names = sc.get();
        begin();
        Object.keys(secs).forEach(function (s) { if (names.indexOf(s) < 0) return; Object.keys(secs[s]).forEach(function (k) { mset(s, k, secs[s][k] | 0); }); });
        commit(); render();
      }
    }]);
  }

  // ------------------------------------------------------------------ open / save
  async function loadFrom(store) {
    var data = (await store.list('DATA')).map(function (f) { return f.name.toUpperCase(); });
    var have = function (n) { return data.indexOf(n) >= 0; };
    if (!have('MEMORY1.RC0') && !have('MEMORY2.RC0')) throw new Error('No MEMORY1.RC0 / MEMORY2.RC0 in ROLAND/DATA');
    async function readPair(base) {
      var b1 = have(base + '1.RC0') ? await store.read('DATA/' + base + '1.RC0') : null;
      var b2 = have(base + '2.RC0') ? await store.read('DATA/' + base + '2.RC0') : null;
      var c1 = b1 ? RC0.readCounter(b1) : 0, c2 = b2 ? RC0.readCounter(b2) : 0;
      var pick = RC0.pickFiles(c1, c2, !!b1, !!b2);
      var db;
      try { db = RC0.parse(pick.load === 1 ? b1 : b2); }
      catch (e) { // newest copy damaged: fall back to the other one
        var other = pick.load === 1 ? b2 : b1; if (!other) throw e;
        db = RC0.parse(other); pick = { load: pick.write, write: pick.load };
      }
      return { db: db, load: pick.load, write: pick.write, counter: Math.max(c1, c2) };
    }
    var m = await readPair('MEMORY'), s = await readPair('SYSTEM');
    if (m.db.blocks.length !== 99 || !RC0.section(m.db.blocks[0], 'LOOPFX')) {
      throw new Error('This is a ' + (m.db.name || 'unknown') + ' data file. Only the RC-500 is supported.');
    }
    S.store = store; S.mem = m.db; S.sys = s.db;
    S.origMem = RC0.clone(m.db); S.origSys = RC0.clone(s.db);
    S.files = { mem: m, sys: s, memName: 'MEMORY' + m.load + '.RC0', sysName: 'SYSTEM' + s.load + '.RC0' };
    S.undo = []; S.redo = []; S.loops = null; S.loopStore = null; S.loopDriveGone = false;
    var mn = sget('SETUP', 'MemoryNumber'); S.cur = mn >= 0 && mn < 99 ? mn : 0;
    toast('Loaded ' + S.files.memName + ' and ' + S.files.sysName + (store.writable ? '' : ' (read-only)'));
    render();
    if (store.hasWave) scanLoops().then(renderMemList).catch(function () { });
  }

  async function confirmDiscard() {
    if (!anyDirty()) return true;
    return new Promise(function (res) {
      dialog('Unsaved changes', h('p', null, 'Discard the changes you have not saved?'),
        [{ label: 'Cancel', onclick: function () { res(false); } }, { label: 'Discard', danger: true, onclick: function () { res(true); } }]);
    });
  }

  /** Firefox and other browsers without folder access: read the folder through a file input. */
  function pickViaInput() {
    return new Promise(function (res, rej) {
      var inp = $('dirinput');
      inp.onchange = function (e) {
        var files = e.target.files; inp.value = '';
        if (!files.length) { rej(new Error('Cancelled')); return; }
        PF.Storage.fromFileList(files).then(res, rej);
      };
      inp.click();
    });
  }

  /** Ask the user to select the drive (a click lets the browser show its folder picker). */
  function askForDrive(intro, needPerm) {
    return new Promise(function (res, rej) {
      var how = PF.Storage.canWriteDirect
        ? (PF.isAndroid ? 'In the picker, open the BOSS RC-500 USB drive and tap “Use this folder”.' : 'In the window that opens, choose the drive called BOSS RC-500.')
        : 'Choose the drive called BOSS RC-500. Firefox asks whether to “upload” the files — they stay on your computer, the editor only reads them.';
      dialog(needPerm ? 'Allow access to the pedal' : 'Select the pedal’s drive', h('div', null, intro,
        h('p', { class: 'info' }, needPerm ? 'Your browser asks once per visit before the editor may use the drive again.' : how),
        null),
        [{ label: 'Cancel', onclick: function () { rej(new Error('Cancelled')); } },
        { label: needPerm ? 'Allow' : 'Select the drive', primary: true, onclick: function () {
          var p = needPerm ? PF.Storage.openRemembered(true) : PF.Storage.canWriteDirect ? PF.Storage.pick() : pickViaInput();
          p.then(res, rej);
        } }]);
    });
  }

  // Android only sees the drive if the pedal is already in storage mode when the cable goes in, and it doesn't notice
  // the drive going away. Switching the mode from the app gets Android stuck on a drive that isn't there, so on Android
  // the user starts storage mode on the pedal before plugging in, and ejects in My Files before leaving it.
  function canAutoStorage() { return S.midi.connected && S.midi.sysexOk && PF.Storage.canWriteDirect && !PF.isAndroid; }
  var ANDROID_STEPS = ['Unplug the USB cable from the phone.',
    'On the pedal: MENU › STORAGE › CONNECTING (the display shows “PREPARING…”).',
    'Plug the cable back in – the display changes to “CONNECTING…” and the app opens the drive.'];
  var ANDROID_EJECT = 'When you’re done with the loops: open My Files (Mina filer), tap ⏏ next to USB storage, and only then leave storage mode or pull the cable.';
  function androidStorageHelp() {
    return h('div', { class: 'empty' }, h('h2', null, 'Loops'),
      h('p', { class: 'warn' }, 'Note: mounting the pedal’s drive is buggy on Android. It only works reliably with the steps below, and sometimes needs a second try (or a phone restart). Direct mode and editing aren’t affected.'),
      h('p', null, 'The loops are on the pedal’s USB drive. On Android the pedal has to be in storage mode before the cable goes into the phone:'),
      h('ol', null, ANDROID_STEPS.map(function (t) { return h('li', null, t); })),
      h('p', { class: 'info' }, ANDROID_EJECT),
      h('p', null, h('button', { onclick: openLoopFolder }, 'Open the pedal drive or a folder…')));
  }
  var ANDROID_REPLUG = 'If the drive isn’t listed: unplug the USB cable from the phone, choose MENU › STORAGE › CONNECTING on the pedal (the display shows “PREPARING…”) and plug the cable back in – Android sometimes only picks up the drive that way.';
  var MANUAL_STORAGE = PF.isAndroid
    ? 'Unplug the USB cable from the phone. On the pedal: press MENU, choose STORAGE, turn the knob to CONNECTING and press it (the display shows “PREPARING…”). Plug the cable back in – the display changes to “CONNECTING…”.'
    : 'On the pedal: press MENU, choose STORAGE, turn the knob to CONNECTING and press it. The display shows “CONNECTING…” and a drive called BOSS RC-500 appears on the computer.';

  /**
   * Get the pedal's drive: the remembered one if it is there, otherwise switch the pedal to storage mode
   * over USB (where the browser allows it), wait for the drive, and ask only when we have to.
   */
  async function getDrive(b) {
    var needPerm = false, v;
    async function reachable(view) { var l = await view.list('DATA'); return l.length > 0; }
    try { v = await PF.Storage.openRemembered(false); if (v && !pedalSaysNoDrive() && await reachable(v)) return v; }
    catch (e) { if (e && e.code === 'needs-permission') needPerm = true; }

    var auto = canAutoStorage(), why = '';
    if (!auto && S.midi.connected && !S.midi.sysexOk) why = 'the browser didn’t allow SysEx messages, which the editor needs to switch the mode.';
    if (auto) {
      b.set('Switching the pedal to storage mode…');
      // If the pedal is still leaving storage mode (e.g. you just came from Direct), wait for that to finish.
      for (var w = 0; storageLock && w < 60; w++) { b.set('Waiting for the pedal to finish switching…'); await PF.sleep(500); }
      if (storageLock) throw new Error('The pedal is already switching storage mode – try again in a moment.');
      b.set('Switching the pedal to storage mode…');
      storageLock = true;
      try {
        var on = (await S.midi.queryEditMode()) === 1;
        if (!on) {
          var r = await S.midi.setEditMode(true, 20000);
          // The pedal can keep answering "busy" until the computer has mounted its drive, so busy counts as on its way.
          on = r.ok || r.last === 2; if (on) S.autoStorage = true;
          else why = r.last === -1 ? 'The pedal didn’t answer the request to switch to storage mode.'
            : r.last === 2 ? 'The pedal was still busy switching when the editor gave up waiting.'
            : 'The pedal answered but stayed in play mode – it may not switch while it plays or shows a menu.';
          if (why) logMidi('mark', null, '──── storage mode: ' + why + ' ────');
        }
      } finally { storageLock = false; }
      if (on) {
        S.storage = true;
        var remembered = await PF.Storage.hasRemembered();
        b.set('Waiting for the BOSS RC-500 drive…');
        for (var t = 0; t < 25 && remembered && !needPerm; t++) {
          try { v = await PF.Storage.openRemembered(false); if (v && await reachable(v)) return v; }
          catch (e) { if (e && e.code === 'needs-permission') needPerm = true; }
          await PF.sleep(1000);
        }
        if (!remembered) await PF.sleep(3000); // give the computer a moment to mount the new drive
      } else auto = false;
    }
    b.hide();
    try {
      return await askForDrive(h('p', null, auto ? 'The pedal is in storage mode now.' : PF.isAndroid && S.storage ? 'The pedal is in storage mode. ' + ANDROID_REPLUG : MANUAL_STORAGE,
        why ? h('br') : null, why ? h('small', null, 'Couldn’t switch it automatically: ' + why) : null), needPerm);
    } finally { b.show(); }
  }

  /** Read the memories from the pedal, switching storage mode on when needed. */
  async function loadFromPedal() {
    if (!(await confirmDiscard())) return;
    var b = busy('Looking for the pedal…');
    try {
      var view = await getDrive(b);
      b.set('Reading the memories…');
      await loadFrom(view);
      b.close();
      if (S.page === 'start') render();
    } catch (e) { b.close(); if (e.name !== 'AbortError' && e.message !== 'Cancelled') errToast(e); }
  }

  /** Leave storage mode so the pedal reloads its data and can play again. */
  /** Switch the pedal back to play mode. opts.ejected: the user has already confirmed the drive is ejected. */
  async function leaveStorage(opts) {
    opts = typeof opts === 'object' && opts ? opts : { quiet: !!opts };
    if (!S.midi.connected) { if (!opts.quiet) toast('Eject the drive, then leave storage mode on the pedal (press EXIT).'); S.storage = false; render(); return; }
    if (!opts.ejected && !(await confirmEjected(opts.intro))) { render(); return false; }
    var fromLoops = S.page === 'loops';
    return withStorageLock(async function () {
      if (!PF.isAndroid) await PF.sleep(500);
      var r = await S.midi.setEditMode(false);
      S.storage = false; S.autoStorage = false; S.loopDriveGone = true; S.driveWritten = false;
      // Left from the Loops tab: don't switch straight back. Moved to Loops meanwhile: let it open the drive again.
      S.loopTried = fromLoops || S.page !== 'loops';
      if (!opts.quiet) toast(r.ok ? 'The pedal is back in play mode and has reloaded its memories' : 'Leave storage mode on the pedal (press EXIT)', r.ok ? '' : 'err');
      render();
      return true;
    });
  }

  async function openFolder() {
    if (!(await confirmDiscard())) return;
    try {
      if (PF.Storage.canWriteDirect) await loadFrom(await PF.Storage.pick());
      else await loadFrom(await pickViaInput());
    } catch (e) { if (e.name !== 'AbortError' && e.message !== 'Cancelled') errToast(e); }
  }
  async function openFactory() {
    if (!(await confirmDiscard())) return;
    S.store = null; S.files = null; S.loops = null;
    S.mem = RC0.factoryMemory(); S.sys = RC0.factorySystem();
    S.origMem = RC0.clone(S.mem); S.origSys = RC0.clone(S.sys);
    S.undo = []; S.redo = []; S.cur = 0; render();
  }

  async function save() {
    if (!S.mem) return;
    var memChanged = false; for (var i = 0; i < 99; i++) if (memDirty(i)) { memChanged = true; break; }
    var sysChanged = sysDirty();
    if (S.store && !memChanged && !sysChanged) { toast('Nothing to save'); return; }

    if (S.store && S.store.writable) {
      var f = S.files;
      var list = [];
      if (memChanged) list.push(['MEMORY', S.mem, f.mem]);
      if (sysChanged) list.push(['SYSTEM', S.sys, f.sys]);
      return new Promise(function (res) {
        dialog('Save to the pedal', h('div', null,
          h('p', null, 'Write your changes to the pedal?'),
          h('p', { class: 'info' }, S.midi.connected && S.midi.sysexOk
            ? 'The editor switches the pedal to storage mode, writes, checks the result and switches back. The pedal must be stopped.'
            : 'The pedal must be in storage mode (MENU › STORAGE › CONNECTING).'),
          h('p', { class: 'info' }, 'The pedal keeps the previous version as a fallback. A backup of your own is a good idea the first time.')),
          [{ label: 'Cancel', onclick: function () { res(); } }, { label: '⬇ Backup first', onclick: function () { backup().catch(errToast); return false; } }, {
            label: 'Save', primary: true, onclick: async function () {
              var b = busy('Getting the pedal ready…');
              try {
                // Make sure the drive is there (switching storage mode on if needed).
                try { await S.store.list('DATA').then(function (l) { if (!l.length) throw new Error('empty'); }); }
                catch (e) { S.store = await getDrive(b); }
                // Did the pedal save its memories since we loaded them? Then don't overwrite blindly.
                b.set('Checking the pedal’s files…');
                for (var k = 0; k < list.length; k++) {
                  var x = list[k], c1 = 0, c2 = 0;
                  try { c1 = RC0.readCounter(await S.store.read('DATA/' + x[0] + '1.RC0')); } catch (e) { }
                  try { c2 = RC0.readCounter(await S.store.read('DATA/' + x[0] + '2.RC0')); } catch (e) { }
                  if (Math.max(c1, c2) !== x[2].counter) {
                    b.hide();
                    var goOn = await new Promise(function (ok) {
                      dialog('The pedal has newer changes', h('p', null, 'The pedal saved its ' + (x[0] === 'MEMORY' ? 'memories' : 'system settings') +
                        ' after you loaded them (for example a recording or a WRITE on the pedal). Saving now replaces those changes with what you see in the editor.'),
                        [{ label: 'Cancel', onclick: function () { ok(false); } }, { label: 'Save anyway', danger: true, onclick: function () { ok(true); } }]);
                    });
                    b.show();
                    if (!goOn) throw new Error('Cancelled');
                    var pk = RC0.pickFiles(c1, c2, true, true);
                    x[2].counter = Math.max(c1, c2); x[2].load = pk.load; x[2].write = pk.write;
                  }
                }
                for (k = 0; k < list.length; k++) {
                  x = list[k];
                  var counter = (x[2].counter + 2) >>> 0, bytes = RC0.serialize(x[1], counter);
                  var path = 'DATA/' + x[0] + x[2].write + '.RC0';
                  b.set('Writing ' + x[0] + x[2].write + '.RC0…');
                  S.driveWritten = true;
                  await S.store.write(path, bytes);
                  var back = await S.store.read(path);
                  if (back.length !== bytes.length || back.some(function (v, n) { return v !== bytes[n]; })) throw new Error('Verification of ' + path + ' failed');
                  x[2].counter = counter; var t = x[2].load; x[2].load = x[2].write; x[2].write = t;
                }
                S.files.memName = 'MEMORY' + f.mem.load + '.RC0'; S.files.sysName = 'SYSTEM' + f.sys.load + '.RC0';
                S.origMem = RC0.clone(S.mem); S.origSys = RC0.clone(S.sys);
                if (S.midi.connected && S.midi.sysexOk && S.storage) {
                  b.close();
                  var left = await leaveStorage({ quiet: true, intro: 'Saved and checked.' });
                  toast(left ? 'Saved. The pedal has reloaded its memories.' : 'Saved. Eject the drive and leave storage mode when you are ready (Start page or the pedal’s EXIT).');
                } else {
                  b.close();
                  dialog('Saved', h('div', null, h('p', null, 'Written and checked.'),
                    h('p', null, PF.isAndroid ? 'Leave storage mode on the pedal (EXIT) so it reloads its memories.' : 'Eject the BOSS RC-500 drive, then leave storage mode on the pedal (EXIT) so it reloads its memories.')));
                }
                render();
              } catch (e) { b.close(); if (e.message !== 'Cancelled') errToast(e); }
              res();
            }
          }]);
      });
    }

    // Read-only folder (Firefox) or factory data: download the files.
    var files = [];
    if (S.store) {
      if (memChanged) files.push({ name: 'MEMORY' + S.files.mem.write + '.RC0', data: RC0.serialize(S.mem, S.files.mem.counter + 2) });
      if (sysChanged) files.push({ name: 'SYSTEM' + S.files.sys.write + '.RC0', data: RC0.serialize(S.sys, S.files.sys.counter + 2) });
    } else {
      files.push({ name: 'MEMORY1.RC0', data: RC0.serialize(S.mem, 2) }, { name: 'MEMORY2.RC0', data: RC0.serialize(S.mem, 1) },
        { name: 'SYSTEM1.RC0', data: RC0.serialize(S.sys, 2) }, { name: 'SYSTEM2.RC0', data: RC0.serialize(S.sys, 1) });
    }
    dialog('Download the changed files', h('div', null,
      h('p', null, S.store ? 'This browser can’t write to the drive, so download these files and copy them into ' : 'You are editing factory data. Download all four files and copy them into ',
        h('code', null, 'ROLAND/DATA'), ' on the BOSS RC-500 drive, replacing the files with the same name:'),
      h('ul', { class: 'dl' }, files.map(function (f) { return h('li', null, h('button', { onclick: function () { PF.saveFile(f.name, f.data).catch(errToast); toast('Downloading ' + f.name); } }, '⬇ ' + f.name)); }),
        h('li', null, h('button', { onclick: function () {
          PF.saveFile('rc500-changed-files.zip', AU.zip(files.map(function (f) { return { name: 'ROLAND/DATA/' + f.name, data: f.data }; })), 'application/zip').catch(errToast);
          toast('Downloading rc500-changed-files.zip');
        }, title: 'The same files in a ZIP, inside ROLAND/DATA folders' }, '⬇ All as ZIP'))),
      h('p', { class: 'info' }, 'Check that the downloaded names are exactly as shown (no “(1)” added). ' + (S.store ? '' : 'Replacing all four files overwrites every memory and system setting on the pedal.'))),
      [{ label: 'Close' }, { label: 'Mark as saved', primary: true, onclick: function () {
        if (S.store) { if (memChanged) S.files.mem.counter += 2; if (sysChanged) S.files.sys.counter += 2; }
        S.origMem = RC0.clone(S.mem); S.origSys = RC0.clone(S.sys); render();
      } }]);
  }

  async function backup() {
    if (!S.store) { toast('Open the pedal folder first'); return; }
    var files = [], data = await S.store.list('DATA');
    for (var i = 0; i < data.length; i++) if (!data[i].dir) files.push({ name: 'ROLAND/DATA/' + data[i].name, data: await S.store.read('DATA/' + data[i].name) });
    var d = new Date(), stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    await PF.saveFile('rc500-backup-' + stamp + '.zip', AU.zip(files), 'application/zip');
    toast('Backup of ROLAND/DATA saved (loops not included — copy ROLAND/WAVE yourself to keep them)');
  }

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    var t = localStorage.getItem('rc500-theme') || 'auto';
    document.documentElement.dataset.theme = t;
    var b = $('btnMore'); if (!b) return;
    var svg = {
      auto: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
      light: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
      dark: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor"/></svg>'
    };
    b.innerHTML = svg[t];
    b.title = THEMES[t][1] + ' – click to change';
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    try { applyTheme(); } catch (e) { }
    $('btnLoad').onclick = function () { loadFromPedal(); };
    $('btnSave').onclick = function () { save().catch(errToast); };
    $('btnUndo').onclick = function () { undoRedo(S.undo, S.redo, true); };
    $('btnRedo').onclick = function () { undoRedo(S.redo, S.undo, false); };
    $('btnMore').onclick = moreMenu;
    $('status').onclick = statusPopup;
    $('memPick').onclick = function () { document.body.classList.add('show-list'); $('memfilter').value = ''; renderMemList(); };
    $('btnCloseList').onclick = function () { document.body.classList.remove('show-list'); };
    $('memfilter').oninput = renderMemList;
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.onclick = function () { go(b.dataset.page); }; });
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoRedo(S.undo, S.redo, true); }
      if (e.key === 'y' || (e.key === 'z' && e.shiftKey) || e.key === 'Z') { e.preventDefault(); undoRedo(S.redo, S.undo, false); }
      if (e.key === 's') { e.preventDefault(); save().catch(errToast); }
    });
    window.addEventListener('beforeunload', function (e) { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });
    window.addEventListener('unhandledrejection', function (e) { if (e.reason && e.reason.message === 'Cancelled') return; errToast(e.reason); });

    S.mem = RC0.factoryMemory(); S.sys = RC0.factorySystem();
    S.origMem = RC0.clone(S.mem); S.origSys = RC0.clone(S.sys);
    try { S.page = sessionStorage.getItem('rc500-page') || 'start'; localStorage.removeItem('rc500-page'); } catch (e) { S.page = 'start'; }
    if (!window.isSecureContext && !PF.isAndroid) {
      var https = 'https://jonsolberg.github.io/rc500editor/';
      $('banner').appendChild(h('div', { class: 'warn' }, 'This page is not served over https, so the browser blocks USB MIDI and saving to the pedal. ',
        h('a', { href: https }, 'Open the https version'), ' for all features.'));
    }
    render();
    // Connect to the pedal and its drive by ourselves where that is possible without asking.
    S.midi.autoConnect(function () { toast('Connected to ' + S.midi.name); afterConnect(); });
    PF.Storage.openRemembered(false).then(function (st) {
      if (!st) return;
      return st.list('DATA').then(function (l) { if (l.length) return loadFrom(st); });
    }).catch(function () { });
  }

  // Interface for js/direct.js
  var API = {
    S: S, h: h, P: P, RC0: RC0, pad2: pad2, mget: mget, mset: mset, sget: sget, blk: blk, rxCh: rxCh,
    midiSend: midiSend, connectMidi: connectMidi, render: render, begin: begin, commit: commit,
    toast: toast, dialog: dialog, selectMemory: selectMemory,
    go: go, loadFromPedal: loadFromPedal, leaveStorage: leaveStorage
  };

  // Android back button: close dialogs / list first.
  window.rc500Back = function () {
    var m = document.querySelector('.modal-back'); if (m) { m.remove(); return true; }
    if (document.body.classList.contains('show-list')) { document.body.classList.remove('show-list'); return true; }
    if (S.page !== 'start') { go('start'); return true; }
    return false;
  };

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', boot) : boot();
})();
