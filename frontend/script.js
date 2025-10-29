const STORAGE_KEY = 'waAutomation.sessionCode';

const state = {
 code: '',
 customReplies: [],
 qrIntervalId: null,
 scheduleJobs: [],
 hasStoredApiKey: false,
 hasStoredSpeechToTextApiKey: false,
 hasStoredTextToSpeechApiKey: false,
};

const elements = {};

// DOM sanitization helper
function sanitizeHTML(str) {
 const div = document.createElement('div');
 div.textContent = str;
 return div.innerHTML;
}

function cacheElements() {
 elements.codeInput = document.getElementById('code');
 elements.startSessionBtn = document.getElementById('startSessionBtn');
 elements.authSection = document.getElementById('authSection');
 elements.qrBox = document.getElementById('qrBox');
 elements.qrImg = document.getElementById('qrImg');
 elements.controlPanel = document.getElementById('controlPanel');
 elements.sessionIndicator = document.getElementById('sessionIndicator');
 elements.logoutBtn = document.getElementById('logoutBtn');
 
 // Tab buttons
 elements.tabButtons = document.querySelectorAll('.tab-button');
 
 // AI Config
 elements.apiKey = document.getElementById('apiKey');
 elements.apiKeyHint = document.getElementById('apiKeyHint');
 elements.model = document.getElementById('model');
 elements.systemPrompt = document.getElementById('systemPrompt');
 elements.autoReplyEnabled = document.getElementById('autoReplyEnabled');
 elements.contextWindow = document.getElementById('contextWindow');
 elements.aiStatus = document.getElementById('aiStatus');
 elements.saveAiBtn = document.getElementById('saveAiBtn');
 
 // Custom Replies
 elements.customTrigger = document.getElementById('customTrigger');
 elements.customMatchType = document.getElementById('customMatchType');
 elements.customResponse = document.getElementById('customResponse');
 elements.customRepliesTable = document.getElementById('customRepliesTable');
 elements.customRepliesBody = elements.customRepliesTable?.querySelector('tbody');
 elements.customReplyStatus = document.getElementById('customReplyStatus');
 elements.batchCustomReplies = document.getElementById('batchCustomReplies');
 elements.addCustomReplyBtn = document.getElementById('addCustomReplyBtn');
 elements.saveCustomRepliesBtn = document.getElementById('saveCustomRepliesBtn');
 elements.clearAllRepliesBtn = document.getElementById('clearAllRepliesBtn');
 elements.importBatchBtn = document.getElementById('importBatchBtn');
 
 // Bulk Messages
 elements.bulkNumbers = document.getElementById('bulkNumbers');
 elements.bulkCsv = document.getElementById('bulkCsv');
 elements.bulkMessage = document.getElementById('bulkMessage');
 elements.bulkStatus = document.getElementById('bulkStatus');
 elements.sendBulkBtn = document.getElementById('sendBulkBtn');
 
 // Scheduling
 elements.scheduleDateTime = document.getElementById('scheduleDateTime');
 elements.scheduleNumbers = document.getElementById('scheduleNumbers');
 elements.scheduleMessage = document.getElementById('scheduleMessage');
 elements.scheduleStatus = document.getElementById('scheduleStatus');
 elements.scheduleTable = document.getElementById('scheduleTable');
 elements.scheduleTableBody = elements.scheduleTable?.querySelector('tbody');
 elements.createScheduleBtn = document.getElementById('createScheduleBtn');
 elements.refreshScheduleBtn = document.getElementById('refreshScheduleBtn');
 
 // Utils / Voice
 elements.voiceReplyEnabled = document.getElementById('voiceReplyEnabled');
 elements.speechToTextApiKey = document.getElementById('speechToTextApiKey');
 elements.speechToTextApiKeyHint = document.getElementById('speechToTextApiKeyHint');
 elements.textToSpeechApiKey = document.getElementById('textToSpeechApiKey');
 elements.textToSpeechApiKeyHint = document.getElementById('textToSpeechApiKeyHint');
 elements.voiceLanguage = document.getElementById('voiceLanguage');
 elements.voiceGender = document.getElementById('voiceGender');
 elements.voiceName = document.getElementById('voiceName'); // <-- ADDED
 elements.saveVoiceConfigBtn = document.getElementById('saveVoiceConfigBtn');
 elements.voiceConfigStatus = document.getElementById('voiceConfigStatus');
 elements.voiceApiStatusBox = document.getElementById('voiceApiStatusBox');
 elements.geminiKeyStatus = document.getElementById('geminiKeyStatus');
 elements.speechToTextKeyStatus = document.getElementById('speechToTextKeyStatus');
 elements.textToSpeechKeyStatus = document.getElementById('textToSpeechKeyStatus');
}

function showElement(element, visible) {
 if (!element) return;
 element.classList[visible ? 'remove' : 'add']('hidden');
}

function setStatus(element, message, type = 'info') {
 if (!element) return;
 if (!message) {
  element.textContent = '';
  element.classList.add('hidden');
  element.classList.remove('error', 'success');
  return;
 }
 element.textContent = sanitizeHTML(message);
 element.classList.remove('hidden', 'error', 'success');
 if (type === 'error') element.classList.add('error');
 if (type === 'success') element.classList.add('success');
}

function persistAuthCode(code) {
 try {
  localStorage.setItem(STORAGE_KEY, code);
 } catch (error) {
  console.warn('Unable to persist auth code', error);
 }
}

function clearPersistedCode() {
 try {
  localStorage.removeItem(STORAGE_KEY);
 } catch (error) {
  console.warn('Unable to clear persisted auth code', error);
 }
}

function stopQrPolling() {
 if (state.qrIntervalId) {
  clearInterval(state.qrIntervalId);
  state.qrIntervalId = null;
 }
}

function updateSessionIndicator(code) {
 if (!elements.sessionIndicator) return;
 if (!code) {
  elements.sessionIndicator.textContent = 'Not connected';
 } else {
  elements.sessionIndicator.textContent = `Connected with code: ${code}`;
 }
 elements.logoutBtn?.classList.toggle('hidden', !code);
}

function resetUiToLoggedOut() {
 stopQrPolling();
 state.code = '';
 state.customReplies = [];
 state.scheduleJobs = [];
 state.hasStoredApiKey = false;
 state.hasStoredSpeechToTextApiKey = false;
 state.hasStoredTextToSpeechApiKey = false;
 showElement(elements.authSection, true);
 showElement(elements.qrBox, false);
 showElement(elements.controlPanel, false);
 updateSessionIndicator('');
 if (elements.codeInput) {
  elements.codeInput.value = '';
 }
 if (elements.qrImg) {
  elements.qrImg.src = '';
 }
 if (elements.apiKey) {
  elements.apiKey.value = '';
  elements.apiKey.placeholder = 'Enter your API key';
 }
 if (elements.apiKeyHint) {
  elements.apiKeyHint.textContent = '';
  elements.apiKeyHint.classList.add('hidden');
 }
  // Reset voice fields
  if (elements.speechToTextApiKey) elements.speechToTextApiKey.value = '';
  if (elements.textToSpeechApiKey) elements.textToSpeechApiKey.value = '';
  if (elements.voiceLanguage) elements.voiceLanguage.value = 'en-US';
  if (elements.voiceGender) elements.voiceGender.value = 'NEUTRAL';
  if (elements.voiceName) elements.voiceName.value = ''; // <-- ADDED Reset
  if (elements.voiceReplyEnabled) elements.voiceReplyEnabled.checked = false;

 renderCustomReplies();
 if (elements.scheduleTableBody) {
  elements.scheduleTableBody.innerHTML = '';
 }
 setStatus(elements.aiStatus, '');
 setStatus(elements.customReplyStatus, '');
 setStatus(elements.bulkStatus, '');
 setStatus(elements.scheduleStatus, '');
  setStatus(elements.voiceConfigStatus, ''); // <-- ADDED Reset
}

// Tab navigation
function switchTab(tabName) {
 document.querySelectorAll('.tab-button').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.tab === tabName);
 });
 document.querySelectorAll('.tab-content').forEach(content => {
  content.classList.toggle('active', content.id === tabName);
 });
}

function handleTabClick(event) {
 const button = event.target.closest('.tab-button');
 if (!button || !button.dataset.tab) return;
 switchTab(button.dataset.tab);
}

async function startAuth() {
 const code = elements.codeInput.value.trim();
 if (!code) {
  alert('Enter an auth code first.');
  return;
 }

 try {
  const res = await fetch('/auth', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!data.success) {
   alert(data.error || 'Authentication failed');
   return;
  }
  state.code = code;
  persistAuthCode(code);
  updateSessionIndicator(code);
  pollQR().catch(err => console.error('QR polling start error', err));
 } catch (error) {
  console.error('Auth error', error);
  alert('Unable to start session. Please try again.');
 }
}

async function pollQR() {
 if (!state.code) return;
 stopQrPolling();
 showElement(elements.qrBox, true);
 showElement(elements.controlPanel, false);
 showElement(elements.authSection, false);

 let active = true;
 let pending = false;

 const checkStatus = async () => {
  if (!active || pending) return;
  pending = true;
  try {
   const res = await fetch(`/qr/${encodeURIComponent(state.code)}`);
   if (res.status === 404 || res.status === 401) {
    active = false;
    clearPersistedCode();
    resetUiToLoggedOut();
    return;
   }

   const data = await res.json();

   if (data.ready) {
    active = false;
    stopQrPolling();
    showElement(elements.qrBox, false);
    showElement(elements.controlPanel, true);
    updateSessionIndicator(state.code);
    await Promise.all([loadAiConfig(), fetchScheduledMessages()]);
    return;
   }

   if (data.qr) {
    elements.qrImg.src = data.qr;
   }
  } catch (error) {
   console.error('QR polling error', error);
  } finally {
   pending = false;
  }
 };

 await checkStatus();
 if (!active) {
  return;
 }

 state.qrIntervalId = setInterval(checkStatus, 2000);
}

async function logout() {
 const code = state.code;
 stopQrPolling();
 clearPersistedCode();

 if (code) {
  try {
   const res = await fetch(`/auth/${encodeURIComponent(code)}`, {
    method: 'DELETE',
   });
   if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.warn('Logout request failed', data?.error || res.statusText);
   }
  } catch (error) {
   console.error('Logout error', error);
  }
 }

 resetUiToLoggedOut();
}

async function resumeSessionFromStorage() {
 let storedCode;
 try {
  storedCode = localStorage.getItem(STORAGE_KEY);
 } catch (error) {
  console.warn('Unable to access stored auth code', error);
  return;
 }

 if (!storedCode) {
  return;
 }

 state.code = storedCode;
 if (elements.codeInput) {
  elements.codeInput.value = storedCode;
 }
 updateSessionIndicator(storedCode);

 try {
  const res = await fetch(`/auth/${encodeURIComponent(storedCode)}/status`);
  if (res.status === 401 || res.status === 404) {
   clearPersistedCode();
   resetUiToLoggedOut();
   return;
  }

  const data = await res.json();
  if (!data.active) {
   clearPersistedCode();
   resetUiToLoggedOut();
   return;
  }

  showElement(elements.authSection, false);

  if (data.ready) {
   showElement(elements.qrBox, false);
   showElement(elements.controlPanel, true);
   await Promise.all([loadAiConfig(), fetchScheduledMessages()]);
  } else {
   await pollQR();
  }
 } catch (error) {
  console.error('Resume session error', error);
  clearPersistedCode();
  resetUiToLoggedOut();
 }
}

async function loadAiConfig() {
 if (!state.code) return;
 try {
  const res = await fetch(`/ai/${encodeURIComponent(state.code)}`);
  if (!res.ok) {
   throw new Error('Failed to fetch AI config');
  }
  const data = await res.json();
  const config = data?.config || {};

  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';

  state.customReplies = Array.isArray(config.customReplies) ? config.customReplies : [];
  state.hasStoredApiKey = Boolean(apiKey || config.hasApiKey);
  elements.apiKey.value = apiKey;
  elements.apiKey.placeholder = state.hasStoredApiKey
   ? 'API key loaded from secure storage'
   : 'Enter your API key';
  if (elements.apiKeyHint) {
   if (state.hasStoredApiKey) {
    elements.apiKeyHint.textContent = 'Existing API key loaded. Update the value to replace it or clear it to reuse the stored key.';
    elements.apiKeyHint.classList.remove('hidden');
   } else {
    elements.apiKeyHint.textContent = '';
    elements.apiKeyHint.classList.add('hidden');
   }
  }
  elements.model.value = sanitizeHTML(config.model || '');
  elements.systemPrompt.value = sanitizeHTML(config.systemPrompt || '');
  elements.autoReplyEnabled.checked = config.autoReplyEnabled !== false;
  elements.contextWindow.value = Number(config.contextWindow) || 50;
  
  // Load voice settings
  if (elements.voiceReplyEnabled) {
   elements.voiceReplyEnabled.checked = config.voiceReplyEnabled || false;
  }
  if (elements.speechToTextApiKey) {
   const speechToTextKey = sanitizeHTML(config.speechToTextApiKey || '');
   elements.speechToTextApiKey.value = speechToTextKey;
   state.hasStoredSpeechToTextApiKey = Boolean(speechToTextKey || config.hasSpeechToTextApiKey);
   elements.speechToTextApiKey.placeholder = state.hasStoredSpeechToTextApiKey
    ? 'Speech-to-Text API key loaded from secure storage'
    : 'Google Cloud Speech-to-Text API key';
   
   // Show/hide hint for Speech-to-Text API key
   if (elements.speechToTextApiKeyHint) {
    if (state.hasStoredSpeechToTextApiKey) {
     elements.speechToTextApiKeyHint.textContent = '✓ API key loaded from database. Update to replace or clear to reuse stored key.';
     elements.speechToTextApiKeyHint.classList.remove('hidden');
     elements.speechToTextApiKeyHint.style.color = '#16a34a'; // Green
    } else {
     elements.speechToTextApiKeyHint.textContent = '';
     elements.speechToTextApiKeyHint.classList.add('hidden');
    }
   }
  }
  if (elements.textToSpeechApiKey) {
   const textToSpeechKey = sanitizeHTML(config.textToSpeechApiKey || '');
   elements.textToSpeechApiKey.value = textToSpeechKey;
   state.hasStoredTextToSpeechApiKey = Boolean(textToSpeechKey || config.hasTextToSpeechApiKey);
   elements.textToSpeechApiKey.placeholder = state.hasStoredTextToSpeechApiKey
    ? 'Text-to-Speech API key loaded from secure storage'
    : 'Google Cloud Text-to-Speech API key';
   
   // Show/hide hint for Text-to-Speech API key
   if (elements.textToSpeechApiKeyHint) {
    if (state.hasStoredTextToSpeechApiKey) {
     elements.textToSpeechApiKeyHint.textContent = '✓ API key loaded from database. Update to replace or clear to reuse stored key.';
     elements.textToSpeechApiKeyHint.classList.remove('hidden');
     elements.textToSpeechApiKeyHint.style.color = '#16a34a'; // Green
    } else {
     elements.textToSpeechApiKeyHint.textContent = '';
     elements.textToSpeechApiKeyHint.classList.add('hidden');
    }
   }
  }
  if (elements.voiceLanguage) {
   elements.voiceLanguage.value = sanitizeHTML(config.voiceLanguage || 'en-US');
  }
  if (elements.voiceGender) {
   elements.voiceGender.value = sanitizeHTML(config.voiceGender || 'NEUTRAL');
  }
  // --- ADDED: Load voiceName ---
  if (elements.voiceName) {
   elements.voiceName.value = sanitizeHTML(config.voiceName || ''); 
  }
  // --- END ---
  
  // Update API keys status box
  if (elements.voiceApiStatusBox && elements.geminiKeyStatus && elements.speechToTextKeyStatus && elements.textToSpeechKeyStatus) {
   const hasAnyStoredKey = state.hasStoredApiKey || state.hasStoredSpeechToTextApiKey || state.hasStoredTextToSpeechApiKey;
   
   if (hasAnyStoredKey) {
    showElement(elements.voiceApiStatusBox, true);
    showElement(elements.geminiKeyStatus, state.hasStoredApiKey);
    showElement(elements.speechToTextKeyStatus, state.hasStoredSpeechToTextApiKey);
    showElement(elements.textToSpeechKeyStatus, state.hasStoredTextToSpeechApiKey);
   } else {
    showElement(elements.voiceApiStatusBox, false);
   }
  }
  
  renderCustomReplies();
 } catch (error) {
  console.error('Load AI config error', error);
  setStatus(elements.aiStatus, 'Unable to load configuration', 'error');
 }
}

function renderCustomReplies() {
 if (!elements.customRepliesTable || !elements.customRepliesBody) return;
 if (!state.customReplies.length) {
  showElement(elements.customRepliesTable, false);
  elements.customRepliesBody.innerHTML = '';
  return;
 }

 const rows = state.customReplies
  .map(
   (entry, index) => `
    <tr data-index="${index}">
     <td>${sanitizeHTML(entry.trigger)}</td>
     <td>${sanitizeHTML(entry.matchType)}</td>
     <td>${sanitizeHTML(entry.response.length > 60 ? entry.response.slice(0, 57) + '...' : entry.response)}</td>
     <td><button type="button" class="danger small" data-remove="${index}">Remove</button></td>
    </tr>`
  )
  .join('');
 elements.customRepliesBody.innerHTML = rows;
 showElement(elements.customRepliesTable, true);
}

function addCustomReply() {
 const trigger = elements.customTrigger.value.trim();
 const response = elements.customResponse.value.trim();
 const matchType = elements.customMatchType.value;

 if (!trigger || !response) {
  setStatus(elements.customReplyStatus, 'Trigger and response are required', 'error');
  return;
 }

 if (matchType === 'regex') {
  try {
   new RegExp(trigger);
  } catch (err) {
   setStatus(elements.customReplyStatus, `Invalid regex pattern: ${err.message}`, 'error');
   return;
  }
 }

 state.customReplies.push({ trigger, response, matchType });
 elements.customTrigger.value = '';
 elements.customResponse.value = '';
 renderCustomReplies();
 setStatus(elements.customReplyStatus, 'Rule added (remember to save)', 'success');
}

function importBatchReplies() {
 const raw = elements.batchCustomReplies.value.trim();
 if (!raw) {
  setStatus(elements.customReplyStatus, 'Batch input is empty', 'error');
  return;
 }

 const lines = raw.split('\n').filter(line => line.trim());
 let imported = 0;
 let skipped = 0;

 for (const line of lines) {
  const parts = line.split('|').map(p => p.trim());
  if (parts.length < 3) {
   skipped++;
   continue;
  }

  const [trigger, matchType, response] = parts;
  if (!trigger || !response) {
   skipped++;
   continue;
  }

  const validMatchTypes = ['contains', 'exact', 'startsWith', 'regex'];
  const normalizedMatchType = validMatchTypes.includes(matchType) ? matchType : 'contains';

  if (normalizedMatchType === 'regex') {
   try {
    new RegExp(trigger);
   } catch (err) {
    console.warn('Invalid regex in batch import:', trigger, err.message);
    skipped++;
    continue;
   }
  }

  state.customReplies.push({
   trigger,
   response,
   matchType: normalizedMatchType,
  });
  imported++;
 }

 elements.batchCustomReplies.value = '';
 renderCustomReplies();
 setStatus(
  elements.customReplyStatus,
  `Imported ${imported} rules${skipped > 0 ? `, skipped ${skipped}` : ''} (remember to save)`,
  'success'
 );
}

function clearAllReplies() {
 if (!confirm('Delete all custom reply rules? This cannot be undone.')) {
  return;
 }
 state.customReplies = [];
 renderCustomReplies();
 setStatus(elements.customReplyStatus, 'All rules cleared (remember to save)', 'success');
}

function handleCustomRepliesClick(event) {
 const button = event.target.closest('button[data-remove]');
 if (!button) return;
 const index = Number(button.dataset.remove);
 if (Number.isNaN(index)) return;
 state.customReplies.splice(index, 1);
 renderCustomReplies();
 setStatus(elements.customReplyStatus, 'Rule removed (remember to save)', 'success');
}

async function saveCustomReplies() {
 if (!state.code) return;
 const payload = {
  customReplies: state.customReplies,
 };

 try {
  const res = await fetch(`/ai/${encodeURIComponent(state.code)}/replies`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (res.ok && data.success) {
   setStatus(elements.customReplyStatus, 'Custom replies saved', 'success');
   await loadAiConfig();
  } else {
   setStatus(elements.customReplyStatus, data.error || 'Failed to save', 'error');
  }
 } catch (error) {
  console.error('Save custom replies error', error);
  setStatus(elements.customReplyStatus, 'Unable to reach server', 'error');
 }
}

async function saveAiConfig() {
 if (!state.code) return;

 const apiKey = elements.apiKey.value.trim();
 const model = elements.model.value.trim();
 const contextWindow = Number(elements.contextWindow.value) || 50;
 const reuseStoredApiKey = state.hasStoredApiKey && !apiKey;

 if ((!apiKey && !reuseStoredApiKey) || !model) {
  setStatus(elements.aiStatus, 'Model is required and you must provide an API key or reuse the stored one.', 'error');
  return;
 }

 if (contextWindow < 10 || contextWindow > 1000) {
  setStatus(elements.aiStatus, 'Context window must be between 10 and 1000', 'error');
  return;
 }

 const payload = {
  apiKey,
  reuseStoredApiKey,
  model,
  systemPrompt: elements.systemPrompt.value,
  autoReplyEnabled: elements.autoReplyEnabled.checked,
  contextWindow,
  customReplies: state.customReplies, // Keep custom replies here for simplicity if needed
  // Voice Settings
  voiceReplyEnabled: elements.voiceReplyEnabled?.checked || false,
  speechToTextApiKey: elements.speechToTextApiKey?.value.trim() || '',
  textToSpeechApiKey: elements.textToSpeechApiKey?.value.trim() || '',
  voiceLanguage: elements.voiceLanguage?.value || 'en-US',
  voiceGender: elements.voiceGender?.value || 'NEUTRAL',
  voiceName: elements.voiceName?.value.trim() || '', // <-- ADDED
 };

 try {
  const res = await fetch(`/ai/${encodeURIComponent(state.code)}`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (data.success) {
   setStatus(elements.aiStatus, 'AI configuration saved successfully', 'success');
   setStatus(elements.voiceConfigStatus, 'Voice configuration saved successfully', 'success');
   const savedConfig = data.config || {};
   const persistedInfo = data.persisted || {};
   
   // Update Gemini API key state
   const savedKey = typeof savedConfig.apiKey === 'string' ? savedConfig.apiKey : apiKey;
   elements.apiKey.value = savedKey;
   state.hasStoredApiKey = Boolean(savedKey || savedConfig.hasApiKey || persistedInfo.hasApiKey || reuseStoredApiKey);
   
   // Update voice API keys state
   state.hasStoredSpeechToTextApiKey = Boolean(
    savedConfig.speechToTextApiKey || 
    persistedInfo.hasSpeechToTextApiKey
   );
   state.hasStoredTextToSpeechApiKey = Boolean(
    savedConfig.textToSpeechApiKey || 
    persistedInfo.hasTextToSpeechApiKey
   );
   
   // Reload the config to reflect saved state, including placeholders
   await loadAiConfig(); 
  } else {
   setStatus(elements.aiStatus, data.error || 'Failed to save configuration', 'error');
   setStatus(elements.voiceConfigStatus, data.error || 'Failed to save configuration', 'error');
  }
 } catch (error) {
  console.error('Save AI config error', error);
  setStatus(elements.aiStatus, 'Unable to reach server', 'error');
  setStatus(elements.voiceConfigStatus, 'Unable to reach server', 'error'); // Add status for voice tab too
 }
}

function parseNumbersInput(raw) {
 const numbers = Array.from(
  new Set(
   String(raw || '')
    .split(/[\s,;\r\n]+/)
    .map((value) => value.trim())
    .filter(Boolean)
  )
 );
 
 return numbers.filter(num => {
  const cleaned = num.replace(/[^\d+]/g, '');
  return cleaned.length >= 8;
 });
}

async function sendBulkMessages() {
 if (!state.code) return;
 const numbers = parseNumbersInput(elements.bulkNumbers.value);
 const message = elements.bulkMessage.value.trim();

 if (!numbers.length) {
  setStatus(elements.bulkStatus, 'Provide at least one valid phone number', 'error');
  return;
 }
 if (!message) {
  setStatus(elements.bulkStatus, 'Message content is required', 'error');
  return;
 }

 if (message.length > 4000) {
  setStatus(elements.bulkStatus, 'Message is too long (max 4000 characters)', 'error');
  return;
 }

 try {
  const res = await fetch(`/messages/${encodeURIComponent(state.code)}/bulk`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ numbers, message }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
   throw new Error(data.error || 'Bulk send failed');
  }
  setStatus(
   elements.bulkStatus,
   `Sent to ${data.success} of ${data.total} recipients. ${data.failed} failed.`,
   'success'
  );
  elements.bulkMessage.value = '';
 } catch (error) {
  console.error('Bulk message error', error);
  setStatus(elements.bulkStatus, sanitizeHTML(error.message), 'error');
 }
}

function handleCsvUpload(event) {
 const file = event.target.files?.[0];
 if (!file) return;

 if (file.size > 1024 * 1024) {
  setStatus(elements.bulkStatus, 'File is too large (max 1 MB)', 'error');
  return;
 }

 const reader = new FileReader();
 reader.onload = (loadEvent) => {
  const text = loadEvent.target?.result || '';
  const numbers = parseNumbersInput(text);
  const existing = parseNumbersInput(elements.bulkNumbers.value);
  const merged = Array.from(new Set([...existing, ...numbers]));
  elements.bulkNumbers.value = merged.join('\n');
  setStatus(elements.bulkStatus, `Imported ${numbers.length} numbers from file`, 'success');
 };
 reader.onerror = () => {
  setStatus(elements.bulkStatus, 'Failed to read file', 'error');
 };
 reader.readAsText(file);
}

async function createSchedule() {
 if (!state.code) return;

 const sendAtRaw = elements.scheduleDateTime.value;
 const numbers = parseNumbersInput(elements.scheduleNumbers.value);
 const message = elements.scheduleMessage.value.trim();

 if (!sendAtRaw) {
  setStatus(elements.scheduleStatus, 'Schedule date and time are required', 'error');
  return;
 }
 if (!numbers.length) {
  setStatus(elements.scheduleStatus, 'Provide at least one valid phone number', 'error');
  return;
 }
 if (!message) {
  setStatus(elements.scheduleStatus, 'Message content is required', 'error');
  return;
 }

 if (message.length > 4000) {
  setStatus(elements.scheduleStatus, 'Message is too long (max 4000 characters)', 'error');
  return;
 }

 const sendAt = new Date(sendAtRaw);
 if (sendAt.getTime() <= Date.now() + 10000) {
  setStatus(elements.scheduleStatus, 'Schedule time must be at least 10 seconds in the future', 'error');
  return;
 }

 const sendAtIso = sendAt.toISOString();

 try {
  const res = await fetch(`/messages/${encodeURIComponent(state.code)}/schedule`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ sendAt: sendAtIso, numbers, message }),
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
   throw new Error(data.error || 'Failed to schedule message');
  }
  setStatus(elements.scheduleStatus, 'Message scheduled successfully', 'success');
  elements.scheduleMessage.value = '';
  elements.scheduleNumbers.value = '';
  elements.scheduleDateTime.value = '';
  await fetchScheduledMessages();
 } catch (error) {
  console.error('Schedule error', error);
  setStatus(elements.scheduleStatus, sanitizeHTML(error.message), 'error');
 }
}

async function fetchScheduledMessages() {
 if (!state.code) return;
 try {
  const res = await fetch(`/messages/${encodeURIComponent(state.code)}/schedule`);
  if (!res.ok) {
   throw new Error('Failed to load schedules');
  }
  const data = await res.json();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  state.scheduleJobs = jobs;
  renderScheduleTable();
 } catch (error) {
  console.error('Fetch schedules error', error);
 }
}

function renderScheduleTable() {
 if (!elements.scheduleTable || !elements.scheduleTableBody) return;
 if (!state.scheduleJobs.length) {
  elements.scheduleTableBody.innerHTML = '';
  showElement(elements.scheduleTable, false);
  return;
 }

 const rows = state.scheduleJobs
  .map((job) => {
   const preview = job.message?.length > 50 ? `${sanitizeHTML(job.message.slice(0, 47))}...` : sanitizeHTML(job.message || '');
   const sendAt = job.sendAt ? new Date(job.sendAt).toLocaleString() : '—';
   const status = sanitizeHTML(job.status || 'unknown');
   const disableCancel = status === 'sent' || status === 'failed' || status === 'cancelled';
   const disableRemove = job.status === 'sending';
   return `
    <tr data-id="${sanitizeHTML(job.id)}">
     <td>${sendAt}</td>
     <td>${status}</td>
     <td>${Array.isArray(job.numbers) ? job.numbers.length : 0}</td>
     <td>${preview}</td>
     <td>
      <div class="button-group">
       <button type="button" class="danger small" data-cancel="${sanitizeHTML(job.id)}" ${
        disableCancel ? 'disabled' : ''
       }>Cancel</button>
       <button type="button" class="secondary small" data-remove-schedule="${sanitizeHTML(job.id)}" ${
        disableRemove ? 'disabled' : ''
       }>Remove</button>
      </div>
     </td>
    </tr>`;
  })
  .join('');

 elements.scheduleTableBody.innerHTML = rows;
 showElement(elements.scheduleTable, true);
}

async function cancelSchedule(jobId) {
 if (!state.code) return;
 try {
  const res = await fetch(`/messages/${encodeURIComponent(state.code)}/schedule/${encodeURIComponent(jobId)}`, {
   method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
   throw new Error(data.error || 'Failed to cancel schedule');
  }
  setStatus(elements.scheduleStatus, 'Schedule cancelled', 'success');
  await fetchScheduledMessages();
 } catch (error) {
  console.error('Cancel schedule error', error);
  setStatus(elements.scheduleStatus, sanitizeHTML(error.message), 'error');
 }
}

async function removeSchedule(jobId) {
 if (!state.code) return;
 try {
  const res = await fetch(`/messages/${encodeURIComponent(state.code)}/schedule/${encodeURIComponent(jobId)}?mode=remove`, {
   method: 'DELETE',
  });
  const data = await res.json();
  if (!res.ok || !data.success) {
   throw new Error(data.error || 'Failed to remove schedule');
  }
  setStatus(elements.scheduleStatus, 'Schedule removed', 'success');
  await fetchScheduledMessages();
 } catch (error) {
  console.error('Remove schedule error', error);
  setStatus(elements.scheduleStatus, sanitizeHTML(error.message), 'error');
 }
}

function handleScheduleTableClick(event) {
 const cancelButton = event.target.closest('button[data-cancel]');
 if (cancelButton) {
  const jobId = cancelButton.dataset.cancel;
  if (jobId) cancelSchedule(jobId);
  return;
 }

 const removeButton = event.target.closest('button[data-remove-schedule]');
 if (removeButton) {
  const jobId = removeButton.dataset.removeSchedule;
  if (jobId) removeSchedule(jobId);
 }
}

document.addEventListener('DOMContentLoaded', () => {
 cacheElements();
 
 // Auth
 elements.startSessionBtn?.addEventListener('click', startAuth);
 elements.logoutBtn?.addEventListener('click', logout);
 
 // Tab navigation
 elements.tabButtons?.forEach(btn => {
  btn.addEventListener('click', handleTabClick);
 });
 
 // AI Config & Utils/Voice (Shared Save Button)
 elements.saveAiBtn?.addEventListener('click', saveAiConfig);
 elements.saveVoiceConfigBtn?.addEventListener('click', saveAiConfig); // Both buttons call the same function
 
 // Custom Replies
 elements.addCustomReplyBtn?.addEventListener('click', addCustomReply);
 elements.importBatchBtn?.addEventListener('click', importBatchReplies);
 elements.saveCustomRepliesBtn?.addEventListener('click', saveCustomReplies);
 elements.clearAllRepliesBtn?.addEventListener('click', clearAllReplies);
 elements.customRepliesBody?.addEventListener('click', handleCustomRepliesClick);
 
 // Bulk Messages
 elements.bulkCsv?.addEventListener('change', handleCsvUpload);
 elements.sendBulkBtn?.addEventListener('click', sendBulkMessages);
 
 // Scheduling
 elements.createScheduleBtn?.addEventListener('click', createSchedule);
 elements.refreshScheduleBtn?.addEventListener('click', fetchScheduledMessages);
 elements.scheduleTableBody?.addEventListener('click', handleScheduleTableClick);
 
 // Initialize Persona Manager
 initPersonaManager();
 
 // Initialize
 resumeSessionFromStorage().catch(err => console.error('Startup resume error', err));
});

// ============================================================================
// Persona Manager Functions
// ============================================================================

let personaState = {
  currentView: 'none', // 'none', 'contacts', 'universal', 'contact-detail'
  currentContactId: null,
  allMessages: [],
  filteredMessages: [],
};

function initPersonaManager() {
  console.log('Initializing Persona Manager...');
  
  // Cache persona elements
  elements.viewUniversalPersonaBtn = document.getElementById('viewUniversalPersonaBtn');
  elements.viewContactsBtn = document.getElementById('viewContactsBtn');
  elements.contactSearchInput = document.getElementById('contactSearchInput');
  elements.personaSearchBox = document.getElementById('personaSearchBox');
  elements.personaStats = document.getElementById('personaStats');
  elements.contactsList = document.getElementById('contactsList');
  elements.contactsTable = document.getElementById('contactsTable');
  elements.personaMessages = document.getElementById('personaMessages');
  elements.messagesTable = document.getElementById('messagesTable');
  elements.personaTitle = document.getElementById('personaTitle');
  elements.backToContactsBtn = document.getElementById('backToContactsBtn');
  elements.filterMyReplies = document.getElementById('filterMyReplies');
  elements.personaStatus = document.getElementById('personaStatus');

  console.log('Persona elements cached:', {
    viewUniversalBtn: !!elements.viewUniversalPersonaBtn,
    viewContactsBtn: !!elements.viewContactsBtn,
    contactsTable: !!elements.contactsTable,
    messagesTable: !!elements.messagesTable,
  });

  // Event listeners
  elements.viewUniversalPersonaBtn?.addEventListener('click', loadUniversalPersona);
  elements.viewContactsBtn?.addEventListener('click', loadContacts);
  elements.backToContactsBtn?.addEventListener('click', () => {
    if (personaState.currentView === 'universal') {
      hideAllPersonaViews();
    } else {
      loadContacts();
    }
  });
  elements.contactSearchInput?.addEventListener('input', filterContacts);
  elements.filterMyReplies?.addEventListener('change', filterMessages);
  
  console.log('Persona Manager initialized successfully');
}

function hideAllPersonaViews() {
  elements.personaSearchBox?.classList.add('hidden');
  elements.personaStats?.classList.add('hidden');
  elements.contactsList?.classList.add('hidden');
  elements.personaMessages?.classList.add('hidden');
}

function showPersonaStatus(message, isError = false) {
  if (!elements.personaStatus) return;
  elements.personaStatus.textContent = message;
  elements.personaStatus.className = isError ? 'status error' : 'status success';
  elements.personaStatus.classList.remove('hidden');
  setTimeout(() => elements.personaStatus.classList.add('hidden'), 5000);
}

async function loadContacts() {
  if (!state.code) {
    showPersonaStatus('Please start a session first', true);
    return;
  }

  try {
    console.log('Loading contacts for session:', state.code);
    const response = await fetch(`/persona/${state.code}/contacts`);
    console.log('Contacts response status:', response.status);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Contacts API error:', errorData);
      throw new Error(errorData.error || 'Failed to load contacts');
    }

    const data = await response.json();
    console.log('Contacts data:', data);
    
    hideAllPersonaViews();
    personaState.currentView = 'contacts';
    elements.personaSearchBox?.classList.remove('hidden');
    elements.contactsList?.classList.remove('hidden');

    renderContactsTable(data.contacts);
    showPersonaStatus(`Loaded ${data.total} contacts`);
  } catch (error) {
    console.error('Load contacts error:', error);
    showPersonaStatus('Failed to load contacts: ' + error.message, true);
  }
}

function renderContactsTable(contacts) {
  if (!elements.contactsTable) return;

  const tbody = elements.contactsTable.querySelector('tbody');
  tbody.innerHTML = '';

  if (!contacts || contacts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No contacts found</td></tr>';
    return;
  }

  contacts.forEach(contact => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${sanitizeHTML(contact.contactId)}</td>
      <td>${contact.messageCount}</td>
      <td>${new Date(contact.lastMessageAt).toLocaleString()}</td>
      <td>
        <button class="view-contact-btn" data-contact-id="${sanitizeHTML(contact.contactId)}">
          View Messages
        </button>
      </td>
    `;
    tbody.appendChild(row);
  });

  // Add event listeners to view buttons
  tbody.querySelectorAll('.view-contact-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const contactId = e.target.dataset.contactId;
      loadContactPersona(contactId);
    });
  });
}

function filterContacts() {
  const searchTerm = elements.contactSearchInput?.value.toLowerCase() || '';
  const rows = elements.contactsTable?.querySelectorAll('tbody tr');
  
  rows?.forEach(row => {
    const contactId = row.querySelector('td')?.textContent.toLowerCase() || '';
    row.style.display = contactId.includes(searchTerm) ? '' : 'none';
  });
}

async function loadContactPersona(contactId) {
  if (!state.code) return;

  try {
    const response = await fetch(`/persona/${state.code}/contact/${encodeURIComponent(contactId)}`);
    if (!response.ok) throw new Error('Failed to load contact persona');

    const data = await response.json();
    
    hideAllPersonaViews();
    personaState.currentView = 'contact-detail';
    personaState.currentContactId = contactId;
    personaState.allMessages = data.messages;
    
    elements.personaStats?.classList.remove('hidden');
    elements.personaMessages?.classList.remove('hidden');
    elements.personaTitle.textContent = `Messages for ${contactId}`;

    // Update stats
    document.getElementById('statTotalMessages').textContent = data.total;
    document.getElementById('statUserMessages').textContent = data.userMessages;
    document.getElementById('statMyReplies').textContent = data.myReplies;
    document.getElementById('statAiReplies').textContent = data.aiReplies;

    filterMessages();
    showPersonaStatus(`Loaded ${data.total} messages`);
  } catch (error) {
    console.error('Load contact persona error:', error);
    showPersonaStatus('Failed to load contact persona', true);
  }
}

async function loadUniversalPersona() {
  if (!state.code) {
    showPersonaStatus('Please start a session first', true);
    return;
  }

  try {
    console.log('Loading universal persona for session:', state.code);
    const response = await fetch(`/persona/${state.code}/universal`);
    console.log('Universal persona response status:', response.status);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Universal persona API error:', errorData);
      throw new Error(errorData.error || 'Failed to load universal persona');
    }

    const data = await response.json();
    console.log('Universal persona data:', data);
    
    hideAllPersonaViews();
    personaState.currentView = 'universal';
    personaState.currentContactId = null;
    personaState.allMessages = data.messages.map(msg => ({
      id: msg.id,
      message: msg.message,
      timestamp: new Date(),
    }));
    
    elements.personaMessages?.classList.remove('hidden');
    elements.personaTitle.textContent = 'Universal Persona Messages';
    elements.filterMyReplies.checked = false;
    elements.filterMyReplies.disabled = true;

    filterMessages();
    showPersonaStatus(`Loaded ${data.total} messages`);
  } catch (error) {
    console.error('Load universal persona error:', error);
    showPersonaStatus('Failed to load universal persona: ' + error.message, true);
  }
}

function filterMessages() {
  const filterEnabled = elements.filterMyReplies?.checked && personaState.currentView !== 'universal';
  
  if (filterEnabled) {
    personaState.filteredMessages = personaState.allMessages.filter(msg => 
      msg.message.startsWith('My reply: ')
    );
  } else {
    personaState.filteredMessages = personaState.allMessages;
  }

  renderMessagesTable();
}

function renderMessagesTable() {
  if (!elements.messagesTable) return;

  const tbody = elements.messagesTable.querySelector('tbody');
  tbody.innerHTML = '';

  if (!personaState.filteredMessages || personaState.filteredMessages.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">No messages found</td></tr>';
    return;
  }

  personaState.filteredMessages.forEach((msg) => {
    const row = document.createElement('tr');
    const displayMessage = msg.message.length > 100 
      ? msg.message.substring(0, 100) + '...' 
      : msg.message;
    
    row.innerHTML = `
      <td style="word-break: break-word;">${sanitizeHTML(displayMessage)}</td>
      <td>${new Date(msg.timestamp).toLocaleString()}</td>
      <td>
        <button class="edit-message-btn" data-index="${msg.id}" style="margin-right: 4px;">
          ✏️ Edit
        </button>
        <button class="delete-message-btn" data-index="${msg.id}">
          🗑️ Delete
        </button>
      </td>
    `;
    tbody.appendChild(row);
  });

  // Add event listeners
  tbody.querySelectorAll('.edit-message-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const messageId = parseInt(e.target.dataset.index);
      editMessage(messageId);
    });
  });

  tbody.querySelectorAll('.delete-message-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const messageId = parseInt(e.target.dataset.index);
      deleteMessage(messageId);
    });
  });
}

async function editMessage(messageId) {
  const message = personaState.allMessages.find(m => m.id === messageId);
  if (!message) return;

  const newMessage = prompt('Edit message:', message.message);
  if (!newMessage || newMessage === message.message) return;

  try {
    let url;
    if (personaState.currentView === 'universal') {
      url = `/persona/${state.code}/universal/message/${messageId}`;
    } else {
      url = `/persona/${state.code}/contact/${encodeURIComponent(personaState.currentContactId)}/message/${messageId}`;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: newMessage }),
    });

    if (!response.ok) throw new Error('Failed to update message');

    // Update local state
    message.message = newMessage;
    filterMessages();
    showPersonaStatus('Message updated successfully');
  } catch (error) {
    console.error('Edit message error:', error);
    showPersonaStatus('Failed to update message', true);
  }
}

async function deleteMessage(messageId) {
  if (!confirm('Are you sure you want to delete this message?')) return;

  try {
    let url;
    if (personaState.currentView === 'universal') {
      url = `/persona/${state.code}/universal/message/${messageId}`;
    } else {
      url = `/persona/${state.code}/contact/${encodeURIComponent(personaState.currentContactId)}/message/${messageId}`;
    }

    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete message');

    // Remove from local state
    personaState.allMessages = personaState.allMessages.filter(m => m.id !== messageId);
    filterMessages();
    showPersonaStatus('Message deleted successfully');
  } catch (error) {
    console.error('Delete message error:', error);
    showPersonaStatus('Failed to delete message', true);
  }
}
