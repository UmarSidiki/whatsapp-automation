const STORAGE_KEY = 'waAutomation.sessionCode';
const THEME_STORAGE_KEY = 'waAutomation.theme';

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

// Theme management
function getStoredTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    console.warn('Unable to store theme preference', error);
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (elements.themeIcon) {
    elements.themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  setStoredTheme(theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
}

function initializeTheme() {
  const storedTheme = getStoredTheme();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const defaultTheme = storedTheme || (prefersDark ? 'dark' : 'light');
  applyTheme(defaultTheme);
}

function cacheElements() {
  elements.themeToggle = document.getElementById('themeToggle');
  elements.themeIcon = elements.themeToggle?.querySelector('.theme-icon');
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
  elements.loadPersonaMessagesBtn = document.getElementById('loadPersonaMessagesBtn');
  elements.personaMessagesContainer = document.getElementById('personaMessagesContainer');
  elements.personaMessagesList = document.getElementById('personaMessagesList');
  elements.personaMessagesCount = document.getElementById('personaMessagesCount');
  
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
  renderCustomReplies();
  if (elements.scheduleTableBody) {
    elements.scheduleTableBody.innerHTML = '';
  }
  setStatus(elements.aiStatus, '');
  setStatus(elements.customReplyStatus, '');
  setStatus(elements.bulkStatus, '');
  setStatus(elements.scheduleStatus, '');
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

  if (contextWindow < 10 || contextWindow > 100) {
    setStatus(elements.aiStatus, 'Context window must be between 10 and 100', 'error');
    return;
  }

  const payload = {
    apiKey,
    reuseStoredApiKey,
    model,
    systemPrompt: elements.systemPrompt.value,
    autoReplyEnabled: elements.autoReplyEnabled.checked,
    contextWindow,
    customReplies: state.customReplies,
    voiceReplyEnabled: elements.voiceReplyEnabled?.checked || false,
    speechToTextApiKey: elements.speechToTextApiKey?.value.trim() || '',
    textToSpeechApiKey: elements.textToSpeechApiKey?.value.trim() || '',
    voiceLanguage: elements.voiceLanguage?.value || 'en-US',
    voiceGender: elements.voiceGender?.value || 'NEUTRAL',
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

      await loadAiConfig();
    } else {
      setStatus(elements.aiStatus, data.error || 'Failed to save configuration', 'error');
      setStatus(elements.voiceConfigStatus, data.error || 'Failed to save configuration', 'error');
    }
  } catch (error) {
    console.error('Save AI config error', error);
    setStatus(elements.aiStatus, 'Unable to reach server', 'error');
  }
}

async function loadPersonaMessages() {
  if (!state.code) return;

  try {
    const res = await fetch(`/ai/${encodeURIComponent(state.code)}/persona`);
    if (!res.ok) {
      throw new Error('Failed to load persona messages');
    }
    const data = await res.json();
    const messages = data.messages || [];

    if (messages.length === 0) {
      elements.personaMessagesList.innerHTML = '<p style="color: var(--text-muted); font-style: italic;">No training messages found. Messages will be saved as you chat with the AI.</p>';
      elements.personaMessagesCount.textContent = '0 messages';
    } else {
      const messageItems = messages.map((msg, index) => {
        const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
        if (msg.incoming && msg.outgoing) {
          // Conversation pair
          return `
            <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 6px; font-size: 0.9rem;">
              <div style="margin-bottom: 8px; color: var(--text-muted); font-size: 0.8rem;">${timestamp}</div>
              <div style="margin-bottom: 6px;">
                <strong style="color: var(--primary);">Incoming:</strong> ${sanitizeHTML(msg.incoming)}
              </div>
              <div>
                <strong style="color: var(--success);">Reply:</strong> ${sanitizeHTML(msg.outgoing)}
              </div>
            </div>
          `;
        } else if (msg.outgoing) {
          // Standalone outgoing message
          return `
            <div style="margin-bottom: 8px; padding: 8px; background: var(--bg-secondary); border-radius: 4px; font-size: 0.9rem;">
              <div style="margin-bottom: 4px; color: var(--text-muted); font-size: 0.8rem;">${timestamp}</div>
              <strong>${index + 1}.</strong> ${sanitizeHTML(msg.outgoing)}
            </div>
          `;
        } else {
          // Fallback for old format
          return `
            <div style="margin-bottom: 8px; padding: 8px; background: var(--bg-secondary); border-radius: 4px; font-size: 0.9rem;">
              <strong>${index + 1}.</strong> ${sanitizeHTML(typeof msg === 'string' ? msg : JSON.stringify(msg))}
            </div>
          `;
        }
      }).join('');
      elements.personaMessagesList.innerHTML = messageItems;
      const limit = Number(elements.contextWindow?.value) || 50;
      elements.personaMessagesCount.textContent = `${messages.length} messages (showing latest ${limit})`;
    }

    showElement(elements.personaMessagesContainer, true);
  } catch (error) {
    console.error('Load persona messages error', error);
    elements.personaMessagesList.innerHTML = '<p style="color: var(--danger); font-style: italic;">Failed to load training messages.</p>';
    showElement(elements.personaMessagesContainer, true);
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
  initializeTheme();

  // Theme toggle
  elements.themeToggle?.addEventListener('click', toggleTheme);

  // Auth
  elements.startSessionBtn?.addEventListener('click', startAuth);
  elements.logoutBtn?.addEventListener('click', logout);
  
  // Tab navigation
  elements.tabButtons?.forEach(btn => {
    btn.addEventListener('click', handleTabClick);
  });
  
  // AI Config
  elements.saveAiBtn?.addEventListener('click', saveAiConfig);
  elements.loadPersonaMessagesBtn?.addEventListener('click', loadPersonaMessages);
  
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
  
  // Utils / Voice
  elements.saveVoiceConfigBtn?.addEventListener('click', saveAiConfig);

  resumeSessionFromStorage().catch(err => console.error('Startup resume error', err));
});