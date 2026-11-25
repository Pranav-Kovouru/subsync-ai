const state = { cues: [], videoUrl: null };
const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = 'subsync-ai-project-v1';
const example = `1
00:00:01,000 --> 00:00:03,400
I can't believe we made it this far.

2
00:00:04,000 --> 00:00:06,700
After all that, we're finally home.

3
00:00:07,100 --> 00:00:10,200
Let's make this one count, shall we?`;

function timestampToSeconds(value) {
  const match = value.trim().replace(',', '.').match(/(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function parseSubtitles(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines[0] === 'WEBVTT' || lines[0].startsWith('NOTE') || lines[0].startsWith('STYLE')) continue;
    const timeIndex = lines.findIndex(line => line.includes('-->'));
    if (timeIndex < 0) continue;
    const [startRaw, endRaw] = lines[timeIndex].split('-->').map(part => part.trim().split(/\s+/)[0]);
    if (!startRaw || !endRaw) continue;
    const cueText = lines.slice(timeIndex + 1).join('\n').trim();
    if (cueText) cues.push({ id: String(cues.length + 1), start: startRaw, end: endRaw, text: cueText, translation: '' });
  }
  if (!cues.length) throw new Error('No timed subtitle cues were found. Use a valid SRT or VTT file.');
  return cues;
}

function formatTime(seconds, vtt = false) {
  const ms = Math.round((seconds % 1) * 1000);
  const full = Math.floor(seconds);
  const h = String(Math.floor(full / 3600)).padStart(2, '0');
  const m = String(Math.floor((full % 3600) / 60)).padStart(2, '0');
  const s = String(full % 60).padStart(2, '0');
  return `${h}:${m}:${s}${vtt ? '.' : ','}${String(ms).padStart(3, '0')}`;
}

function render() {
  const populated = state.cues.length > 0;
  $('#cueCount').textContent = `${state.cues.length} cue${state.cues.length === 1 ? '' : 's'}`;
  $('#emptyState').classList.toggle('hidden', populated);
  $('#editorWrap').classList.toggle('hidden', !populated);
  $('#translateButton').disabled = !populated || !$('#targetLanguage').value;
  $('#reviewPanel').classList.toggle('hidden', !populated);
  if (!populated) return;
  $('#subtitleRows').innerHTML = state.cues.map((cue, index) => `
    <div class="cue-row" data-index="${index}">
      <span class="time">${cue.start.replace(',', '.')}<br>→ ${cue.end.replace(',', '.')}</span>
      <span class="original">${escapeHtml(cue.text)}</span>
      <textarea aria-label="Localized subtitle ${index + 1}" placeholder="Translation will appear here">${escapeHtml(cue.translation)}</textarea>
      <button class="delete-cue" aria-label="Delete cue ${index + 1}" title="Delete cue">×</button>
    </div>`).join('');
  runChecks();
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function saveDraft() {
  const fields = ['projectName', 'sourceLanguage', 'targetLanguage', 'tone', 'glossary', 'styleGuide'];
  const data = { cues: state.cues, fields: Object.fromEntries(fields.map(id => [id, $(`#${id}`).value])) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  $('#saveState').textContent = 'Draft saved locally';
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!draft) return;
    state.cues = Array.isArray(draft.cues) ? draft.cues : [];
    for (const [id, value] of Object.entries(draft.fields || {})) if ($(`#${id}`)) $(`#${id}`).value = value;
  } catch { localStorage.removeItem(STORAGE_KEY); }
}

function toast(message, error = false) {
  const node = $('#toast'); node.textContent = message; node.classList.toggle('error', error); node.classList.remove('hidden');
  clearTimeout(toast.timeout); toast.timeout = setTimeout(() => node.classList.add('hidden'), 4200);
}

function updateFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { state.cues = parseSubtitles(reader.result); render(); saveDraft(); toast(`${state.cues.length} subtitle cues imported.`); }
    catch (error) { toast(error.message, true); }
  };
  reader.readAsText(file);
}

function currentSettings() {
  return { sourceLanguage: $('#sourceLanguage').value, targetLanguage: $('#targetLanguage').value, tone: $('#tone').value, glossary: $('#glossary').value, styleGuide: $('#styleGuide').value };
}

async function localize() {
  if (!state.cues.length || !$('#targetLanguage').value) return;
  const button = $('#translateButton'); button.disabled = true; button.innerHTML = '<span>◌</span> Localizing…';
  $('#statusText').textContent = 'Translating your cues with the selected context…';
  try {
    const response = await fetch('/api/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...currentSettings(), segments: state.cues.map(({ id, text }) => ({ id, text })) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Translation request failed.');
    const result = new Map(data.translations.map(item => [item.id, item.text]));
    state.cues.forEach(cue => cue.translation = result.get(cue.id) || cue.translation);
    $('#statusText').textContent = 'Translation complete. Review flagged cues before exporting.';
    render(); saveDraft(); toast('Localization complete.');
  } catch (error) { $('#statusText').textContent = 'Translation needs attention.'; toast(error.message, true); }
  finally { button.disabled = !state.cues.length || !$('#targetLanguage').value; button.innerHTML = '<span>✦</span> Localize subtitles'; }
}

function runChecks() {
  const issues = [];
  let translated = 0;
  state.cues.forEach((cue, i) => {
    const translatedText = cue.translation.trim();
    if (translatedText) translated += 1;
    else issues.push({ type: 'warn', title: `Cue ${i + 1} is not translated`, detail: 'Add a localized subtitle before exporting.' });
    for (const line of translatedText.split('\n')) if (line.length > 42) issues.push({ type: 'warn', title: `Cue ${i + 1} has a long line`, detail: `${line.length} characters; aim for 42 or fewer.` });
    const duration = timestampToSeconds(cue.end) - timestampToSeconds(cue.start);
    const cps = duration > 0 ? translatedText.replace(/\s/g, '').length / duration : 0;
    if (translatedText && cps > 17) issues.push({ type: 'warn', title: `Cue ${i + 1} may be too fast to read`, detail: `${cps.toFixed(1)} characters/sec; aim for 17 or fewer.` });
    const next = state.cues[i + 1];
    if (next && timestampToSeconds(cue.end) > timestampToSeconds(next.start)) issues.push({ type: 'warn', title: `Cues ${i + 1} and ${i + 2} overlap`, detail: 'Adjust their timing before delivery.' });
  });
  const result = $('#qualityResults');
  const summary = state.cues.length ? { type: translated === state.cues.length ? 'ok' : 'warn', title: `${translated}/${state.cues.length} cues localized`, detail: translated === state.cues.length ? 'All cues have translated text.' : 'Complete untranslated cues to deliver the file.' } : null;
  result.innerHTML = [summary, ...issues].filter(Boolean).slice(0, 8).map(item => `<div class="check"><b class="${item.type}">${item.type === 'ok' ? '✓' : '!'}</b><div><strong>${item.title}</strong><p>${item.detail}</p></div></div>`).join('') || '<div class="check"><b class="ok">✓</b><div><strong>Ready to review</strong><p>Import subtitles to run checks.</p></div></div>';
}

function exportSubtitles(vtt) {
  if (!state.cues.length) return;
  const useTranslation = state.cues.some(cue => cue.translation.trim());
  const content = (vtt ? 'WEBVTT\n\n' : '') + state.cues.map((cue, index) => `${vtt ? '' : `${index + 1}\n`}${cue.start.replace(',', vtt ? '.' : ',')} --> ${cue.end.replace(',', vtt ? '.' : ',')}\n${(useTranslation ? cue.translation : cue.text).trim()}\n`).join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
  const safeName = ($('#projectName').value || 'subsync-localized').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  link.download = `${safeName || 'subsync-localized'}.${vtt ? 'vtt' : 'srt'}`; link.click(); URL.revokeObjectURL(link.href);
  toast(`Downloaded ${vtt ? 'VTT' : 'SRT'} file.`);
}

document.addEventListener('DOMContentLoaded', () => {
  loadDraft(); render();
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn === tab)); ['file', 'paste', 'video'].forEach(id => $(`#${id}Tab`).classList.toggle('hidden', id !== tab.dataset.tab)); }));
  $('#subtitleFile').addEventListener('change', e => updateFromFile(e.target.files[0]));
  $('#dropzone').addEventListener('dragover', e => { e.preventDefault(); $('#dropzone').classList.add('drag'); });
  $('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('drag'));
  $('#dropzone').addEventListener('drop', e => { e.preventDefault(); $('#dropzone').classList.remove('drag'); updateFromFile(e.dataTransfer.files[0]); });
  $('#parsePaste').addEventListener('click', () => { try { state.cues = parseSubtitles($('#pasteInput').value); render(); saveDraft(); toast('Pasted subtitles imported.'); } catch (error) { toast(error.message, true); } });
  $('#loadExample').addEventListener('click', () => { state.cues = parseSubtitles(example); $('#projectName').value = 'The homecoming'; $('#targetLanguage').value = 'Spanish'; render(); saveDraft(); });
  $('#subtitleRows').addEventListener('input', e => { if (!e.target.matches('textarea')) return; state.cues[Number(e.target.closest('.cue-row').dataset.index)].translation = e.target.value; runChecks(); saveDraft(); });
  $('#subtitleRows').addEventListener('click', e => { if (!e.target.matches('.delete-cue')) return; state.cues.splice(Number(e.target.closest('.cue-row').dataset.index), 1); state.cues.forEach((cue, i) => cue.id = String(i + 1)); render(); saveDraft(); });
  $('#addCue').addEventListener('click', () => { const last = state.cues.at(-1); const start = last ? timestampToSeconds(last.end) + .2 : 0; state.cues.push({ id: String(state.cues.length + 1), start: formatTime(start), end: formatTime(start + 2), text: 'New subtitle', translation: '' }); render(); saveDraft(); });
  ['projectName', 'sourceLanguage', 'targetLanguage', 'tone', 'glossary', 'styleGuide'].forEach(id => $(`#${id}`).addEventListener('input', () => { render(); saveDraft(); }));
  $('#translateButton').addEventListener('click', localize); $('#runChecks').addEventListener('click', runChecks); $('#exportSrt').addEventListener('click', () => exportSubtitles(false)); $('#exportVtt').addEventListener('click', () => exportSubtitles(true));
  $('#newProject').addEventListener('click', () => { if (!confirm('Start a new project? Your current locally saved draft will be cleared.')) return; state.cues = []; $('#projectName').value = 'Untitled localization'; $('#targetLanguage').value = ''; $('#glossary').value = ''; localStorage.removeItem(STORAGE_KEY); render(); toast('New project created.'); });
  $('#videoFile').addEventListener('change', e => { const file = e.target.files[0]; if (!file) return; if (state.videoUrl) URL.revokeObjectURL(state.videoUrl); state.videoUrl = URL.createObjectURL(file); $('#videoPreview').src = state.videoUrl; $('#videoPreview').classList.remove('hidden'); toast('Video added for local preview only.'); });
});
