// 논문별 로컬 메모 기록(notes.json)과 Zotero 전송 대기열(pending.json).
// notes.json이 기준이다. pending.json의 op는 대상 id만 담고 내용은 항상 notes.json에서 읽는다.
//
// notes.json 추가 필드(브리프 형식의 확장):
//  - libraryVersion: { annotations: number|null, note: number|null }
//      목록별 If-Modified-Since-Version 캐시. annotation 목록(첨부 파일 아래)과
//      note 목록(논문 항목 아래)은 따로 304 판정한다. 예전 숫자 값은 무시(null 취급)한다.
//  - note.conflict: { at } | null  — Zotero에서 노트를 직접 고쳐 덮어쓰지 않은 상태.
//      설정돼 있는 동안 upsert-note op는 대기열에 남되 전송하지 않는다. resolveNoteConflict로 해제.
//  - tombstones: [하이라이트 레코드 사본]
//      로컬에서 지웠지만 Zotero 삭제가 아직 안 된 하이라이트. delete-highlight op가 이것을 읽는다
//      (지울 key가 notes.json에 남아 있어야만 Zotero 항목을 지운다). Zotero에서 그 사이 고쳐졌으면
//      지우지 않고 이 사본으로 되살린다(conflict.mine = { deleted: true }).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSafeName } from '../reader/store.mjs';

export const emptyNotes = () => ({
  version: 1,
  serverId: null,
  highlights: [],
  cardMemos: {},
  note: { zoteroKey: null, zoteroVersion: null },
  zoteroAnnotations: [],
  libraryVersion: { annotations: null, note: null },
  tombstones: [],
});

function paperDir(outputDir, id) {
  if (!isSafeName(id)) throw new Error(`잘못된 논문 id: ${id}`);
  return path.join(outputDir, id);
}

// Missing file -> null. A corrupt file throws, so we never overwrite memos with defaults.
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v) => (Number.isFinite(v) ? v : null);

export async function readNotes(outputDir, id) {
  const raw = await readJson(path.join(paperDir(outputDir, id), 'notes.json'));
  const base = emptyNotes();
  if (!isObj(raw)) return base;
  const lv = isObj(raw.libraryVersion) ? raw.libraryVersion : {};
  return {
    ...base,
    ...raw,
    highlights: Array.isArray(raw.highlights) ? raw.highlights : [],
    cardMemos: isObj(raw.cardMemos) ? raw.cardMemos : {},
    note: isObj(raw.note) ? { ...base.note, ...raw.note } : base.note,
    zoteroAnnotations: Array.isArray(raw.zoteroAnnotations) ? raw.zoteroAnnotations : [],
    libraryVersion: { annotations: numOrNull(lv.annotations), note: numOrNull(lv.note) },
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones : [],
  };
}

export async function writeNotes(outputDir, id, notes) {
  await writeJson(path.join(paperDir(outputDir, id), 'notes.json'), notes);
}

export async function readPending(outputDir, id) {
  const raw = await readJson(path.join(paperDir(outputDir, id), 'pending.json'));
  return { ops: Array.isArray(raw?.ops) ? raw.ops : [] };
}

export async function writePending(outputDir, id, pending) {
  await writeJson(path.join(paperDir(outputDir, id), 'pending.json'), pending);
}

// Per-paper serialization: every mutation and syncPaper run through one promise chain.
const chains = new Map();
export function withPaper(outputDir, id, fn) {
  const k = `${path.resolve(outputDir)}::${id}`;
  const prev = chains.get(k) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(k, tail);
  tail.then(() => {
    if (chains.get(k) === tail) chains.delete(k);
  });
  return run;
}

const now = () => new Date().toISOString();

// Same target -> one op (keeps its queue position, refreshes `at`).
export function enqueue(pending, op, targetId) {
  const same = (o) => o.op === op && (op === 'upsert-note' || o.id === targetId);
  const found = pending.ops.find(same);
  if (found) found.at = now();
  else pending.ops.push(op === 'upsert-note' ? { op, at: now() } : { op, id: targetId, at: now() });
}

async function mutate(outputDir, id, fn) {
  return withPaper(outputDir, id, async () => {
    const notes = await readNotes(outputDir, id);
    const pending = await readPending(outputDir, id);
    const result = fn(notes, pending);
    if (result?.changed === false) return result.value;
    await writeNotes(outputDir, id, notes);
    await writePending(outputDir, id, pending);
    return result?.value;
  });
}

function checkStyle({ color, comment }) {
  if (color !== undefined && typeof color !== 'string') throw new Error('color는 문자열이어야 합니다.');
  if (comment !== undefined && typeof comment !== 'string') throw new Error('comment는 문자열이어야 합니다.');
}

export async function addHighlight(outputDir, id, { sentenceIds, color, comment } = {}) {
  if (!Array.isArray(sentenceIds) || !sentenceIds.length || !sentenceIds.every((s) => typeof s === 'string' && s)) {
    throw new Error('sentenceIds는 비어 있지 않은 문자열 배열이어야 합니다.');
  }
  checkStyle({ color, comment });
  return mutate(outputDir, id, (notes, pending) => {
    let hid;
    do hid = `h-${crypto.randomBytes(4).toString('hex')}`;
    while (notes.highlights.some((h) => h.id === hid));
    const h = {
      id: hid,
      sentenceIds: [...sentenceIds],
      color: color || '#ffd400',
      comment: comment ?? '',
      zoteroKey: null,
      zoteroVersion: null,
      conflict: null,
      createdAt: now(),
    };
    notes.highlights.push(h);
    enqueue(pending, 'upsert-highlight', hid);
    return { value: { ...h } };
  });
}

// Returns the updated highlight, or null when it does not exist.
export async function updateHighlight(outputDir, id, hid, { color, comment } = {}) {
  checkStyle({ color, comment });
  return mutate(outputDir, id, (notes, pending) => {
    const h = notes.highlights.find((x) => x.id === hid);
    if (!h) return { changed: false, value: null };
    if (color !== undefined) h.color = color;
    if (comment !== undefined) h.comment = comment;
    h.conflict = null;
    enqueue(pending, 'upsert-highlight', hid);
    return { value: { ...h } };
  });
}

// Returns true when removed. A never-sent highlight just drops its pending op.
export async function removeHighlight(outputDir, id, hid) {
  return mutate(outputDir, id, (notes, pending) => {
    const h = notes.highlights.find((x) => x.id === hid);
    if (!h) return { changed: false, value: false };
    notes.highlights = notes.highlights.filter((x) => x.id !== hid);
    pending.ops = pending.ops.filter((o) => !(o.op === 'upsert-highlight' && o.id === hid));
    if (h.zoteroKey) {
      notes.tombstones.push({ ...h });
      enqueue(pending, 'delete-highlight', hid);
    }
    return { value: true };
  });
}

// Empty (whitespace-only) text removes the memo.
export async function setCardMemo(outputDir, id, cardId, text) {
  if (typeof cardId !== 'string' || !cardId) throw new Error('cardId가 필요합니다.');
  if (typeof text !== 'string') throw new Error('메모는 문자열이어야 합니다.');
  return mutate(outputDir, id, (notes, pending) => {
    if (text.trim()) notes.cardMemos[cardId] = text;
    else delete notes.cardMemos[cardId];
    enqueue(pending, 'upsert-note');
    return { value: notes.cardMemos[cardId] ?? '' };
  });
}

// After a Zotero-side note edit: 'overwrite' queues my memos over it; 'keep-zotero' drops the
// queued note op and keeps local memos as-is (the next local memo edit writes again).
export async function resolveNoteConflict(outputDir, id, choice) {
  if (choice !== 'overwrite' && choice !== 'keep-zotero') throw new Error(`알 수 없는 선택: ${choice}`);
  return mutate(outputDir, id, (notes, pending) => {
    notes.note.conflict = null;
    if (choice === 'overwrite') enqueue(pending, 'upsert-note');
    else pending.ops = pending.ops.filter((o) => o.op !== 'upsert-note');
    return { value: { ...notes.note } };
  });
}
