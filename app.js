const OPENAI_MAX_FILE_SIZE = 25 * 1024 * 1024;
const GEMINI_MAX_FILE_SIZE = 14 * 1024 * 1024;
const MAX_FILES = 2;
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const GEMINI_MAX_ATTEMPTS = 4;
const SPEAKER_COLORS = ['#ff5a1f', '#5577ff', '#14a06f', '#ad54d3', '#d89a00', '#e14b86'];

const elements = {
  form: document.querySelector('#transcription-form'),
  providers: [...document.querySelectorAll('input[name="provider"]')],
  apiKeyLabel: document.querySelector('#api-key-label'),
  apiKeyHelp: document.querySelector('#api-key-help'),
  apiKey: document.querySelector('#api-key'),
  toggleKey: document.querySelector('#toggle-key'),
  dropZone: document.querySelector('#drop-zone'),
  fileInput: document.querySelector('#audio-file'),
  fileHint: document.querySelector('#file-hint'),
  fileList: document.querySelector('#file-list'),
  language: document.querySelector('#language'),
  submit: document.querySelector('#submit-button'),
  status: document.querySelector('#status'),
  progressPanel: document.querySelector('#progress-panel'),
  progressPhase: document.querySelector('#progress-phase'),
  progressEta: document.querySelector('#progress-eta'),
  progressBar: document.querySelector('#progress-bar'),
  resultSection: document.querySelector('#result-section'),
  speakerEditor: document.querySelector('#speaker-editor'),
  insights: document.querySelector('#insights'),
  summary: document.querySelector('#summary-text'),
  highlights: document.querySelector('#highlights'),
  transcript: document.querySelector('#transcript'),
  copy: document.querySelector('#copy-result'),
  downloadTxt: document.querySelector('#download-txt'),
  downloadJson: document.querySelector('#download-json'),
};

let selectedFiles = [];
let audioUrls = [];
let players = [];
let rawTranscripts = [];
let transcriptData = null;
let insightData = null;
let speakerNames = {};
let progressTimer = null;
let progressState = null;

const activeProvider = () => document.querySelector('input[name="provider"]:checked').value;
const maxFileSize = () => activeProvider() === 'gemini' ? GEMINI_MAX_FILE_SIZE : OPENAI_MAX_FILE_SIZE;
const isSupportedFile = (file) => {
  const pattern = activeProvider() === 'gemini'
    ? /\.(mp3|wav|aiff|aac|ogg|flac)$/i
    : /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i;
  return pattern.test(file.name);
};

const formatBytes = (bytes) => {
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
};

const formatTime = (seconds = 0) => {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const setStatus = (message = '', isError = false) => {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
};

const formatEstimate = (seconds) => {
  const value = Math.max(1, Math.ceil(seconds));
  if (value < 60) return `примерно ${value} сек.`;
  const minutes = Math.ceil(value / 60);
  return `примерно ${minutes} мин.`;
};

const setProgressPhase = (index, label) => {
  if (!progressState) return;
  progressState.index = index;
  progressState.label = label;
  progressState.startedAt = Date.now();
  elements.progressPanel.hidden = false;
  updateProgress();
};

const updateProgress = () => {
  if (!progressState) return;
  const { stages, index, startedAt, label } = progressState;
  const elapsed = (Date.now() - startedAt) / 1000;
  const stageEstimate = stages[index];
  const completed = stages.slice(0, index).reduce((sum, value) => sum + value, 0);
  const total = stages.reduce((sum, value) => sum + value, 0);
  const stageProgress = Math.min(.9, elapsed / Math.max(1, stageEstimate));
  const progress = Math.min(99, ((completed + stageEstimate * stageProgress) / total) * 100);
  const later = stages.slice(index + 1).reduce((sum, value) => sum + value, 0);
  const currentRemaining = elapsed < stageEstimate ? stageEstimate - elapsed : Math.max(8, stageEstimate * .2);
  elements.progressPhase.textContent = label;
  elements.progressEta.textContent = `Осталось ${formatEstimate(currentRemaining + later)}`;
  elements.progressBar.style.width = `${progress}%`;
};

const startProgress = (provider, totalAudioSeconds, totalBytes) => {
  const audioFactor = provider === 'gemini' ? .24 : .2;
  const uploadSeconds = Math.max(8, totalBytes / (1.5 * 1024 * 1024));
  const perRecording = Math.max(18, totalAudioSeconds * audioFactor / MAX_FILES + uploadSeconds / MAX_FILES);
  progressState = { stages: [perRecording, perRecording, Math.max(18, totalAudioSeconds * .08), 18], index: 0, startedAt: Date.now(), label: '' };
  clearInterval(progressTimer);
  progressTimer = setInterval(updateProgress, 1000);
};

const finishProgress = (success) => {
  clearInterval(progressTimer);
  progressTimer = null;
  if (success) {
    elements.progressPhase.textContent = 'Готово';
    elements.progressEta.textContent = 'Обработка завершена';
    elements.progressBar.style.width = '100%';
  } else {
    elements.progressPanel.hidden = true;
  }
  progressState = null;
};

const getAudioDuration = (file) => new Promise((resolve) => {
  const audio = document.createElement('audio');
  const url = URL.createObjectURL(file);
  let settled = false;
  const done = (duration = 0) => {
    if (settled) return;
    settled = true;
    URL.revokeObjectURL(url);
    resolve(Number.isFinite(duration) ? duration : 0);
  };
  const timeout = setTimeout(() => done(0), 5000);
  audio.preload = 'metadata';
  audio.onloadedmetadata = () => { clearTimeout(timeout); done(audio.duration); };
  audio.onerror = () => { clearTimeout(timeout); done(0); };
  audio.src = url;
});

const updateSubmitState = () => {
  elements.submit.disabled = selectedFiles.length !== MAX_FILES || !elements.apiKey.value.trim();
};

const normalizeResponse = (data, fallbackSource = 1) => {
  const rawSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments = rawSegments.map((segment, index) => ({
    id: index,
    speaker: String(segment.speaker ?? 'A'),
    source: Math.min(2, Math.max(1, Number(segment.source) || fallbackSource)),
    start: Math.max(0, Number(segment.start) || 0),
    end: Math.max(0, Number(segment.end ?? segment.start) || 0),
    text: String(segment.text ?? '').trim(),
  })).filter((segment) => segment.text);
  return { text: String(data.text ?? ''), segments };
};

const renderFiles = () => {
  audioUrls.forEach((url) => URL.revokeObjectURL(url));
  audioUrls = selectedFiles.map((file) => URL.createObjectURL(file));
  players = [];
  elements.fileList.replaceChildren(...selectedFiles.map((file, index) => {
    const card = document.createElement('div');
    card.className = 'file-card';
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = String(index + 1);
    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('strong');
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.textContent = `Запись ${index + 1} · ${formatBytes(file.size)}`;
    info.append(name, meta);
    const remove = document.createElement('button');
    remove.className = 'icon-button remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Удалить запись ${index + 1}`);
    remove.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      renderFiles();
      updateSubmitState();
    });
    const player = document.createElement('audio');
    player.controls = true;
    player.src = audioUrls[index];
    players.push(player);
    card.append(icon, info, remove, player);
    return card;
  }));
  elements.dropZone.hidden = selectedFiles.length >= MAX_FILES;
  elements.fileInput.value = '';
};

const addFiles = (fileList) => {
  const incoming = [...fileList];
  if (!incoming.length) return;
  for (const file of incoming) {
    if (selectedFiles.length >= MAX_FILES) break;
    if (!isSupportedFile(file)) {
      const formats = activeProvider() === 'gemini' ? 'MP3, WAV, AIFF, AAC, OGG или FLAC' : 'MP3, M4A, WAV, WEBM или MP4';
      setStatus(`Файл «${file.name}» не подходит. Выберите: ${formats}.`, true);
      continue;
    }
    if (file.size > maxFileSize()) {
      const limit = activeProvider() === 'gemini' ? 14 : 25;
      setStatus(`Файл «${file.name}» больше ${limit} МБ. Сожмите запись или разделите её.`, true);
      continue;
    }
    selectedFiles.push(file);
  }
  renderFiles();
  if (selectedFiles.length < MAX_FILES && !elements.status.classList.contains('error')) {
    setStatus(`Добавьте ещё ${MAX_FILES - selectedFiles.length} аудиофайл.`);
  } else if (selectedFiles.length === MAX_FILES) {
    setStatus('Две записи готовы к обработке.');
  }
  updateSubmitState();
};

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = () => reject(new Error('Не удалось прочитать аудиофайл.'));
  reader.readAsDataURL(file);
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestGemini = async (payload, key, purpose) => {
  let lastError = new Error('Gemini временно недоступен.');
  for (let modelIndex = 0; modelIndex < GEMINI_MODELS.length; modelIndex += 1) {
    const model = GEMINI_MODELS[modelIndex];
    if (modelIndex > 0) {
      setStatus(`${purpose}: основная модель перегружена, переключаемся на ${model}…`);
    }
    for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) return data;
        const error = new Error(data.error?.message || `Ошибка Gemini API (${response.status})`);
        const isTransient = response.status === 429 || response.status >= 500;
        if (!isTransient) throw error;
        error.isTransient = true;
        lastError = error;
      } catch (error) {
        if (!(error instanceof TypeError) && !error.isTransient) throw error;
        lastError = error;
      }
      if (attempt < GEMINI_MAX_ATTEMPTS - 1) {
        const delaySeconds = 2 ** attempt;
        setStatus(`${purpose}: ${model} временно недоступна. Повтор ${attempt + 2} из ${GEMINI_MAX_ATTEMPTS} через ${delaySeconds} сек.…`);
        await wait(delaySeconds * 1000);
      }
    }
  }
  throw lastError;
};

const transcriptSchema = (includeSource = false) => {
  const properties = {
    speaker: { type: 'string', description: 'Stable short speaker identifier such as A, B, C.' },
    start: { type: 'number', description: 'Segment start time in seconds.' },
    end: { type: 'number', description: 'Segment end time in seconds.' },
    text: { type: 'string', description: 'Exact spoken text for this segment.' },
  };
  const required = ['speaker', 'start', 'end', 'text'];
  if (includeSource) {
    properties.source = { type: 'integer', enum: [1, 2], description: 'Recording used for the timestamp.' };
    required.push('source');
  }
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Full clean transcript.' },
      segments: { type: 'array', items: { type: 'object', properties, required, additionalProperties: false } },
    },
    required: ['text', 'segments'],
    additionalProperties: false,
  };
};

const transcribeWithOpenAI = async (file, key, source) => {
  const body = new FormData();
  body.append('file', file, file.name);
  body.append('model', 'gpt-4o-transcribe-diarize');
  body.append('response_format', 'diarized_json');
  body.append('chunking_strategy', 'auto');
  if (elements.language.value) body.append('language', elements.language.value);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Ошибка OpenAI API (${response.status})`);
  return normalizeResponse(data, source);
};

const transcribeWithGemini = async (file, key, source) => {
  const audioData = await fileToBase64(file);
  const language = elements.language.value ? `Use ISO language code ${elements.language.value}.` : 'Detect the language automatically.';
  const payload = {
    contents: [{ role: 'user', parts: [
      { text: `Transcribe this conversation accurately. Identify speakers consistently, split whenever the speaker changes, and include timestamps in seconds. Do not summarize or translate. ${language}` },
      { inlineData: { mimeType: file.type || 'audio/mpeg', data: audioData } },
    ] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: transcriptSchema(false), temperature: 0.1 },
  };
  const data = await requestGemini(payload, key, `Транскрипция записи ${source}`);
  const resultText = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!resultText) throw new Error('Gemini не вернул текст расшифровки.');
  return normalizeResponse(JSON.parse(resultText), source);
};

const transcriptsForPrompt = (transcripts) => transcripts.map((item, index) => ({
  recording: index + 1,
  transcript: item.segments.map((segment) => ({
    speaker: segment.speaker,
    start: segment.start,
    end: segment.end,
    text: segment.text,
  })),
}));

const distillationInstruction = `You are a meticulous transcript editor. Compare two transcriptions that may be recordings of the same conversation. Produce one complete, clean transcript in the original language. Reconcile recognition differences using the clearer version, remove duplicated overlapping speech, filler repetitions and recording artifacts, but never remove unique facts or meaningful statements. Keep distinct speakers consistent across both recordings. If the recordings contain different or non-overlapping parts, preserve all unique content in recording order. For every segment, use a timestamp from the recording where that passage is clearest and set source to 1 or 2. Do not summarize, translate, invent, or add commentary.`;

const distillWithGemini = async (transcripts, key) => {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: `${distillationInstruction}\n\nINPUT:\n${JSON.stringify(transcriptsForPrompt(transcripts))}` }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: transcriptSchema(true), temperature: 0.1 },
  };
  const data = await requestGemini(payload, key, 'Объединение расшифровок');
  const resultText = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!resultText) throw new Error('Gemini не вернул объединённую расшифровку.');
  return normalizeResponse(JSON.parse(resultText), 1);
};

const distillWithOpenAI = async (transcripts, key) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      instructions: distillationInstruction,
      input: JSON.stringify(transcriptsForPrompt(transcripts)),
      text: { format: { type: 'json_schema', name: 'distilled_transcript', strict: true, schema: transcriptSchema(true) } },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Ошибка OpenAI при объединении (${response.status})`);
  const resultText = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!resultText) throw new Error('OpenAI не вернул объединённую расшифровку.');
  return normalizeResponse(JSON.parse(resultText), 1);
};

const insightSchema = () => ({
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Concise retelling in the original language.' },
    highlights: {
      type: 'array',
      minItems: 3,
      maxItems: 7,
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', description: 'Exact short quote from the transcript.' },
          speaker: { type: 'string', description: 'Speaker identifier used in the transcript.' },
          source: { type: 'integer', enum: [1, 2] },
          start: { type: 'number', description: 'Quote start time in seconds.' },
          note: { type: 'string', description: 'Brief explanation of why the quote matters.' },
        },
        required: ['quote', 'speaker', 'source', 'start', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'highlights'],
  additionalProperties: false,
});

const insightInstruction = `Analyze the final transcript without inventing facts. Write a concise, neutral retelling in the transcript's original language. Then select 3 to 7 important short verbatim quotes that capture decisions, arguments, emotions, or conclusions. Preserve the exact wording of every quote and its speaker, source recording, and timestamp. Add a one-sentence note in the original language explaining why each quote matters.`;

const normalizeInsights = (data, transcript) => ({
  summary: String(data.summary || '').trim(),
  highlights: (Array.isArray(data.highlights) ? data.highlights : []).map((item) => {
    const quote = String(item.quote || '').trim();
    const matchingSegment = transcript.segments.find((segment) => segment.text.includes(quote));
    if (!matchingSegment) return null;
    return {
      quote,
      speaker: matchingSegment.speaker,
      source: matchingSegment.source,
      start: matchingSegment.start,
      note: String(item.note || '').trim(),
    };
  }).filter(Boolean),
});

const transcriptForInsights = (transcript) => transcript.segments.map(({ speaker, source, start, text }) => ({
  speaker, source, start, text,
}));

const generateInsightsWithGemini = async (transcript, key) => {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: `${insightInstruction}\n\nFINAL TRANSCRIPT:\n${JSON.stringify(transcriptForInsights(transcript))}` }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: insightSchema(), temperature: 0.1 },
  };
  const data = await requestGemini(payload, key, 'Подготовка пересказа');
  const resultText = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!resultText) throw new Error('Gemini не вернул пересказ и выдержки.');
  return normalizeInsights(JSON.parse(resultText), transcript);
};

const generateInsightsWithOpenAI = async (transcript, key) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      instructions: insightInstruction,
      input: JSON.stringify(transcriptForInsights(transcript)),
      text: { format: { type: 'json_schema', name: 'transcript_insights', strict: true, schema: insightSchema() } },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Ошибка OpenAI при подготовке пересказа (${response.status})`);
  const resultText = data.output_text || data.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!resultText) throw new Error('OpenAI не вернул пересказ и выдержки.');
  return normalizeInsights(JSON.parse(resultText), transcript);
};

const speakerLabel = (speaker) => speakerNames[speaker] || `Собеседник ${speaker}`;

const renderSpeakerEditor = () => {
  const speakers = [...new Set(transcriptData.segments.map((segment) => segment.speaker))];
  elements.speakerEditor.replaceChildren(...speakers.map((speaker, index) => {
    if (!speakerNames[speaker]) speakerNames[speaker] = `Собеседник ${speaker}`;
    const wrapper = document.createElement('div');
    wrapper.className = 'speaker-name';
    const color = document.createElement('label');
    color.style.backgroundColor = SPEAKER_COLORS[index % SPEAKER_COLORS.length];
    const input = document.createElement('input');
    input.value = speakerNames[speaker];
    input.setAttribute('aria-label', `Имя собеседника ${speaker}`);
    input.addEventListener('input', () => {
      speakerNames[speaker] = input.value.trim() || `Собеседник ${speaker}`;
      renderTranscript();
      renderInsights();
    });
    wrapper.append(color, input);
    return wrapper;
  }));
};

const playAt = (source, start) => {
  const player = players[source - 1];
  if (!player) return;
  players.forEach((item) => { if (item !== player) item.pause(); });
  player.currentTime = start;
  player.play().catch(() => {});
};

const renderInsights = () => {
  if (!insightData) return;
  elements.summary.textContent = insightData.summary;
  elements.highlights.replaceChildren(...insightData.highlights.map((item) => {
    const row = document.createElement('div');
    row.className = 'highlight';
    row.title = 'Нажмите, чтобы перейти к фрагменту записи';
    const quote = document.createElement('blockquote');
    quote.textContent = `«${item.quote}»`;
    const meta = document.createElement('span');
    meta.textContent = `${speakerLabel(item.speaker)} · запись ${item.source}, ${formatTime(item.start)} — ${item.note}`;
    row.append(quote, meta);
    row.addEventListener('click', () => playAt(item.source, item.start));
    return row;
  }));
  elements.insights.hidden = false;
};

const renderTranscript = () => {
  elements.transcript.replaceChildren(...transcriptData.segments.map((segment) => {
    const row = document.createElement('article');
    row.className = 'segment';
    const time = document.createElement('time');
    time.textContent = `${segment.source} · ${formatTime(segment.start)}`;
    time.title = `Запись ${segment.source}, ${formatTime(segment.start)}`;
    const speaker = document.createElement('strong');
    speaker.textContent = speakerLabel(segment.speaker);
    const text = document.createElement('p');
    text.textContent = segment.text;
    row.append(time, speaker, text);
    row.addEventListener('click', () => playAt(segment.source, segment.start));
    return row;
  }));
};

const transcriptAsText = () => {
  const summary = insightData?.summary ? `КРАТКИЙ ПЕРЕСКАЗ\n\n${insightData.summary}\n\n` : '';
  const highlights = insightData?.highlights?.length
    ? `КЛЮЧЕВЫЕ ВЫДЕРЖКИ\n\n${insightData.highlights.map((item) => `«${item.quote}» — ${speakerLabel(item.speaker)}, запись ${item.source}, ${formatTime(item.start)}. ${item.note}`).join('\n\n')}\n\n`
    : '';
  const transcript = transcriptData.segments
    .map((segment) => `[Запись ${segment.source} · ${formatTime(segment.start)}] ${speakerLabel(segment.speaker)}: ${segment.text}`)
    .join('\n\n');
  return `${summary}${highlights}РАСШИФРОВКА\n\n${transcript}`;
};

const download = (content, type, extension) => {
  const blob = new Blob([content], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `clean-transcript.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

elements.dropZone.addEventListener('click', () => elements.fileInput.click());
elements.dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') elements.fileInput.click();
});
elements.fileInput.addEventListener('change', () => addFiles(elements.fileInput.files));
['dragenter', 'dragover'].forEach((type) => elements.dropZone.addEventListener(type, (event) => {
  event.preventDefault(); elements.dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((type) => elements.dropZone.addEventListener(type, (event) => {
  event.preventDefault(); elements.dropZone.classList.remove('dragging');
}));
elements.dropZone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
elements.apiKey.addEventListener('input', updateSubmitState);
elements.toggleKey.addEventListener('click', () => {
  const isHidden = elements.apiKey.type === 'password';
  elements.apiKey.type = isHidden ? 'text' : 'password';
  elements.toggleKey.setAttribute('aria-label', isHidden ? 'Скрыть API-ключ' : 'Показать API-ключ');
});
elements.providers.forEach((radio) => radio.addEventListener('change', () => {
  const isGemini = activeProvider() === 'gemini';
  elements.apiKeyLabel.textContent = isGemini ? 'Gemini API-ключ' : 'OpenAI API-ключ';
  elements.apiKey.placeholder = isGemini ? 'AIza...' : 'sk-...';
  elements.apiKeyHelp.textContent = isGemini
    ? 'Ключ из Google AI Studio. Используется только для запросов и не сохраняется.'
    : 'Используется только для запросов и не сохраняется.';
  elements.fileHint.textContent = isGemini
    ? 'MP3, WAV, AAC, OGG, FLAC · до 14 МБ каждый'
    : 'MP3, M4A, WAV, WEBM, MP4 · до 25 МБ каждый';
  selectedFiles = selectedFiles.filter((file) => file.size <= maxFileSize() && isSupportedFile(file));
  renderFiles(); setStatus(selectedFiles.length ? 'Проверьте выбранные файлы после смены провайдера.' : ''); updateSubmitState();
}));

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (selectedFiles.length !== MAX_FILES) return;
  const key = elements.apiKey.value.trim();
  if (!key) return;
  const provider = activeProvider();
  const originalFiles = [...selectedFiles];
  elements.submit.disabled = true;
  elements.submit.classList.add('loading');
  elements.submit.querySelector('span').textContent = 'Обрабатываем две записи…';
  elements.progressPanel.hidden = false;
  elements.progressPhase.textContent = 'Считаем длительность записей…';
  elements.progressEta.textContent = 'Оцениваем время';
  elements.progressBar.style.width = '1%';
  let succeeded = false;
  try {
    const durations = await Promise.all(originalFiles.map(getAudioDuration));
    const measuredDuration = durations.reduce((sum, value) => sum + value, 0);
    const fallbackDuration = originalFiles.reduce((sum, file) => sum + file.size / 16000, 0);
    startProgress(provider, measuredDuration || fallbackDuration, originalFiles.reduce((sum, file) => sum + file.size, 0));
    rawTranscripts = [];
    for (let index = 0; index < originalFiles.length; index += 1) {
      const phase = `Этап ${index + 1} из 4: транскрибируем запись ${index + 1}…`;
      setStatus(phase);
      setProgressPhase(index, phase);
      const result = provider === 'gemini'
        ? await transcribeWithGemini(originalFiles[index], key, index + 1)
        : await transcribeWithOpenAI(originalFiles[index], key, index + 1);
      if (!result.segments.length) throw new Error(`В записи ${index + 1} не найдены реплики.`);
      rawTranscripts.push(result);
    }
    setStatus('Этап 3 из 4: сопоставляем версии, убираем дубли и собираем чистовой текст…');
    setProgressPhase(2, 'Этап 3 из 4: собираем чистовой текст…');
    transcriptData = provider === 'gemini'
      ? await distillWithGemini(rawTranscripts, key)
      : await distillWithOpenAI(rawTranscripts, key);
    if (!transcriptData.segments.length) throw new Error('Модель не вернула чистовой текст.');
    setStatus('Этап 4 из 4: готовим пересказ и ключевые выдержки…');
    setProgressPhase(3, 'Этап 4 из 4: готовим пересказ и выдержки…');
    insightData = provider === 'gemini'
      ? await generateInsightsWithGemini(transcriptData, key)
      : await generateInsightsWithOpenAI(transcriptData, key);
    if (!insightData.summary) throw new Error('Модель не вернула пересказ диалога.');
    speakerNames = {};
    renderSpeakerEditor(); renderInsights(); renderTranscript();
    elements.resultSection.hidden = false;
    elements.resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus(`Готово: ${transcriptData.segments.length} чистовых реплик, пересказ и ${insightData.highlights.length} ключевых выдержек.`);
    succeeded = true;
  } catch (error) {
    const corsHint = error instanceof TypeError ? ' Браузер не смог подключиться к API — проверьте интернет и доступ ключа.' : '';
    setStatus(`${error.message || 'Не удалось обработать записи.'}${corsHint}`, true);
  } finally {
    finishProgress(succeeded);
    elements.submit.classList.remove('loading');
    elements.submit.querySelector('span').textContent = 'Транскрибировать и объединить';
    updateSubmitState();
  }
});

elements.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(transcriptAsText());
    elements.copy.textContent = 'Скопировано';
    setTimeout(() => { elements.copy.textContent = 'Копировать'; }, 1500);
  } catch { setStatus('Браузер запретил буфер обмена. Скачайте TXT-файл.', true); }
});
elements.downloadTxt.addEventListener('click', () => download(transcriptAsText(), 'text/plain;charset=utf-8', 'txt'));
elements.downloadJson.addEventListener('click', () => download(JSON.stringify({
  sources: selectedFiles.map((file) => file.name), speakers: speakerNames, raw_transcripts: rawTranscripts,
  summary: insightData?.summary || '', highlights: insightData?.highlights || [],
  segments: transcriptData.segments.map((segment) => ({ ...segment, speaker_name: speakerLabel(segment.speaker) })),
}, null, 2), 'application/json;charset=utf-8', 'json'));
