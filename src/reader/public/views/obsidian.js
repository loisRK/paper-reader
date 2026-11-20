// Obsidian settings (sidebar) and the paper view's "Obsidian으로 보내기" button.
// Pure helpers are tested in Node; DOM pieces only touch `document` when called.
import { el, setChildren } from './dom.js';

const SETTINGS_PLACE = '목록 화면 왼쪽의 Obsidian 설정';

// Pure: what the Obsidian settings allow. settings = GET /api/obsidian/settings (or null before it loads).
export function obsidianReady(s) {
  if (s?.loadError) {
    const h = 'Obsidian 설정을 읽지 못했습니다.';
    return { export: false, connections: false, exportHint: h, connectionsHint: h };
  }
  const vaultSet = Boolean(s?.vault);
  const vault = vaultSet && s.vaultOk === true;
  const note = Boolean(s?.researchNote);
  let exportHint = null;
  if (!vaultSet) exportHint = `${SETTINGS_PLACE}에서 vault 폴더를 먼저 지정하세요.`;
  else if (!vault) exportHint = `vault를 찾을 수 없습니다. ${SETTINGS_PLACE}을 확인하세요.`;
  let connectionsHint = exportHint;
  if (!connectionsHint && !note) connectionsHint = `${SETTINGS_PLACE}에서 연구 주제 노트를 먼저 고르세요.`;
  return { export: vault, connections: vault && note, exportHint, connectionsHint };
}

const stripMd = (p) => String(p).replace(/\.md$/i, '');

// Pure: <option>s for the research-note picker. Name (no .md) first so a cut-off select still shows it.
export function noteOptions(notes) {
  return (Array.isArray(notes) ? notes : []).filter((n) => typeof n === 'string').map((n) => {
    const bare = stripMd(n);
    const at = bare.lastIndexOf('/');
    return { value: n, text: at < 0 ? bare : `${bare.slice(at + 1)} · ${bare.slice(0, at)}`, title: bare };
  });
}

// Response of POST /api/papers/:id/obsidian: { paperNote, summaryNote (null without a summary) }.
export const exportMessage = (r) => `Obsidian에 저장했습니다: ${r?.paperNote ?? ''}${r?.summaryNote ? ` · ${r.summaryNote}` : ''}`;

export const DEFAULT_FOLDER = 'Papers';
export const DEFAULT_SUMMARY_FOLDER = 'Summaries';

// Pure: PUT body from the current settings plus one change, so saving one field never resets the others.
// A research note belongs to its vault: switching vaults clears it.
export function settingsBody(s, change) {
  const vault = change.vault ?? s.vault;
  const sameVault = vault === s.vault;
  return {
    vault,
    folder: change.folder ?? s.folder ?? DEFAULT_FOLDER,
    summaryFolder: change.summaryFolder ?? s.summaryFolder ?? DEFAULT_SUMMARY_FOLDER,
    researchNote: 'researchNote' in change ? change.researchNote : sameVault ? s.researchNote ?? null : null,
  };
}

// Sidebar "Obsidian" section. actions: obsidianSettings(), saveObsidianSettings(body), obsidianNotes(), toast(msg).
export function obsidianSection(actions) {
  const box = el('div', { class: 'obs-box' }, el('span', { class: 'folder-note', text: '설정 확인 중…' }));
  const section = el('section', { class: 'side-section', 'aria-labelledby': 'h-obsidian' },
    el('h2', { class: 'side-label', id: 'h-obsidian', text: 'Obsidian' }), box);
  if (!actions.obsidianSettings) return section;

  const draw = (s) => {
    const vaultIn = el('input', {
      type: 'text', class: 'folder-input', id: 'obs-vault', name: 'obs-vault', value: s.vault || '',
      placeholder: '/Users/me/Vault', autocomplete: 'off', spellcheck: 'false',
    });
    const folderIn = el('input', {
      type: 'text', class: 'folder-input', id: 'obs-folder', name: 'obs-folder', value: s.folder || DEFAULT_FOLDER,
      placeholder: 'Papers', autocomplete: 'off', spellcheck: 'false',
    });
    const summaryIn = el('input', {
      type: 'text', class: 'folder-input', id: 'obs-summary-folder', name: 'obs-summary-folder', value: s.summaryFolder || DEFAULT_SUMMARY_FOLDER,
      placeholder: DEFAULT_SUMMARY_FOLDER, autocomplete: 'off', spellcheck: 'false',
    });
    const saveBtn = el('button', { type: 'submit', class: 'btn btn-small', text: '저장' });
    const form = el('form', { class: 'obs-form' },
      el('label', { class: 'folder-note', for: 'obs-vault', text: 'vault 폴더 (절대 경로)' }),
      vaultIn,
      s.vault && !s.vaultOk ? el('span', { class: 'folder-warn', role: 'status', text: 'vault를 찾을 수 없습니다' }) : null,
      el('label', { class: 'folder-note', for: 'obs-folder', text: '논문 노트 폴더 (vault 기준)' }),
      folderIn,
      el('label', { class: 'folder-note', for: 'obs-summary-folder', text: '요약 노트 폴더 (vault 기준)' }),
      summaryIn,
      el('div', { class: 'obs-actions' }, saveBtn),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const vault = vaultIn.value.trim();
      if (!vault) { vaultIn.focus(); return; }
      saveBtn.disabled = true;
      try {
        draw(await actions.saveObsidianSettings(settingsBody(s, { vault, folder: folderIn.value.trim(), summaryFolder: summaryIn.value.trim() })));
        actions.toast('Obsidian 설정을 저장했습니다.');
      } catch (err) {
        actions.toast(err.message);
        saveBtn.disabled = false;
      }
    });

    const noteBox = el('div', { class: 'obs-note' });
    setChildren(box, form, noteBox);
    if (!s.vault || !s.vaultOk) {
      setChildren(noteBox, el('span', { class: 'folder-note', text: '연구 주제 노트는 vault를 저장한 뒤 고를 수 있습니다.' }));
      return;
    }
    setChildren(noteBox, el('span', { class: 'folder-note', text: '노트 목록을 읽는 중…' }));
    actions.obsidianNotes().then((r) => {
      const list = [...(r?.notes ?? [])];
      if (s.researchNote && !list.includes(s.researchNote)) list.unshift(s.researchNote);
      const select = el('select', { id: 'obs-note', class: 'agent-select', name: 'obs-note' },
        el('option', { value: '', selected: !s.researchNote, text: '고르지 않음' }),
        noteOptions(list).map((o) => el('option', { value: o.value, title: o.title, selected: o.value === s.researchNote, text: o.text })));
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          draw(await actions.saveObsidianSettings(settingsBody(s, { researchNote: select.value || null })));
          actions.toast(select.value ? '연구 주제 노트를 골랐습니다.' : '연구 주제 노트를 비웠습니다.');
        } catch (err) {
          actions.toast(err.message);
          select.value = s.researchNote ?? '';
          select.disabled = false;
        }
      });
      setChildren(noteBox,
        el('label', { class: 'folder-note', for: 'obs-note', text: '연구 주제 노트' }),
        select,
        el('span', { class: 'folder-note', text: '연구 연결 메모를 만들 때 AI가 읽습니다.' }),
        r?.truncated ? el('span', { class: 'folder-note', text: '노트가 많아 앞의 2000개만 보입니다.' }) : null,
      );
    }, (err) => setChildren(noteBox, el('span', { class: 'folder-warn', text: `노트 목록을 읽지 못했습니다: ${err.message}` })));
  };
  actions.obsidianSettings().then(draw,
    (err) => setChildren(box, el('p', { class: 'folder-note', text: `Obsidian 설정을 읽지 못했습니다: ${err.message}` })));
  return section;
}

// Paper top bar button. Disabled (with a title hint) until settings load and allow exporting.
// Returns { button, setSettings(s) }.
export function exportButton({ id, actions }) {
  const button = el('button', {
    type: 'button', class: 'btn btn-quiet btn-small obs-export', disabled: true, text: 'Obsidian으로 보내기', title: 'Obsidian 설정 확인 중…',
  });
  let ready = false;
  const setSettings = (s) => {
    const r = obsidianReady(s);
    ready = r.export;
    button.disabled = !ready;
    button.title = r.exportHint ?? '논문 노트(내 하이라이트·메모)와 요약 노트(AI 요약·연결 메모)를 Obsidian vault에 저장합니다.';
  };
  button.addEventListener('click', async () => {
    if (!ready) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      actions.toast(exportMessage(await actions.exportObsidian(id)));
    } catch (err) {
      actions.toast(err.message);
    } finally {
      button.disabled = !ready;
      button.removeAttribute('aria-busy');
    }
  });
  return { button, setSettings };
}
