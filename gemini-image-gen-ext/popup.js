let imageFiles = [];
let isRunning = false;
let geminiTabId = null;

const fileInput = document.getElementById('file-input');
const fileDrop = document.getElementById('file-drop');
const fileCountEl = document.getElementById('file-count');
const fileListEl = document.getElementById('file-list');
const promptEl = document.getElementById('prompt');
const delayEl = document.getElementById('delay');
const timeoutEl = document.getElementById('timeout');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const statusBar = document.getElementById('status-bar');

// --- File handling ---
fileDrop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});

function handleFiles(files) {
  imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
  fileCountEl.textContent = imageFiles.length > 0 ? `${imageFiles.length} ảnh đã chọn` : '';
  renderFileList();
}

// Ctrl+V paste ảnh từ clipboard
document.addEventListener('paste', (e) => {
  const items = Array.from(e.clipboardData.items).filter(i => i.type.startsWith('image/'));
  if (items.length === 0) return;
  const pastedFiles = items.map(i => i.getAsFile()).filter(Boolean);
  imageFiles = [...imageFiles, ...pastedFiles];
  fileCountEl.textContent = `${imageFiles.length} ảnh đã chọn`;
  renderFileList();
});

function renderFileList() {
  fileListEl.innerHTML = '';
  if (imageFiles.length === 0) return;

  // Header với nút xóa tất cả
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;';
  header.innerHTML = `
    <span style="font-size:11px;color:#aaa;">${imageFiles.length} ảnh</span>
    <button id="btn-clear-all" style="background:none;border:1px solid #f87171;color:#f87171;padding:2px 8px;border-radius:4px;font-size:10px;cursor:pointer;width:auto;">Xóa tất cả</button>
  `;
  fileListEl.appendChild(header);
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    imageFiles = [];
    fileCountEl.textContent = '';
    renderFileList();
  });

  imageFiles.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'file-item';
    div.id = `file-item-${i}`;

    const url = URL.createObjectURL(f);
    div.innerHTML = `
      <img src="${url}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0;" onload="URL.revokeObjectURL(this.src)" />
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
      <span class="status pending" id="status-${i}">chờ</span>
      <button data-idx="${i}" class="btn-remove" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;padding:0 4px;width:auto;">✕</button>
    `;
    fileListEl.appendChild(div);
  });

  fileListEl.querySelectorAll('.btn-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.dataset.idx);
      imageFiles.splice(idx, 1);
      fileCountEl.textContent = imageFiles.length > 0 ? `${imageFiles.length} ảnh đã chọn` : '';
      renderFileList();
    });
  });
}

function setFileStatus(index, state, text) {
  const el = document.getElementById(`status-${index}`);
  if (!el) return;
  el.className = `status ${state}`;
  el.textContent = text;
}

// --- Main flow ---
btnStart.addEventListener('click', async () => {
  if (imageFiles.length === 0) { statusBar.textContent = '⚠ Chưa chọn ảnh nào!'; return; }
  if (!promptEl.value.trim()) { statusBar.textContent = '⚠ Chưa nhập prompt!'; return; }

  isRunning = true;
  btnStart.disabled = true;
  btnStop.disabled = false;

  const delay = parseInt(delayEl.value) * 1000;
  const timeout = parseInt(timeoutEl.value) * 1000;
  const prompt = promptEl.value.trim();

  // Mở tab Gemini 1 lần duy nhất cho cả batch
  statusBar.textContent = 'Đang mở tab Gemini...';
  try {
    geminiTabId = await openGeminiTab();
  } catch (err) {
    statusBar.textContent = '❌ Không mở được tab Gemini: ' + err.message;
    isRunning = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    return;
  }

  for (let i = 0; i < imageFiles.length; i++) {
    if (!isRunning) break;

    setFileStatus(i, 'running', '⏳ đang gen...');
    statusBar.textContent = `Đang xử lý ảnh ${i + 1}/${imageFiles.length}: ${imageFiles[i].name}`;

    try {
      const base64 = await fileToBase64(imageFiles[i]);
      const result = await sendToGeminiTab(geminiTabId, base64, imageFiles[i].type, prompt, timeout, imageFiles[i].name);

      if (result.success) {
        setFileStatus(i, 'done', '✅ xong');
      } else {
        setFileStatus(i, 'error', '❌ ' + (result.error || 'lỗi'));
        statusBar.textContent = `Lỗi ảnh ${i + 1}: ${result.error}`;
      }
    } catch (err) {
      setFileStatus(i, 'error', '❌ lỗi');
      statusBar.textContent = `Lỗi: ${err.message}`;
    }

    if (i < imageFiles.length - 1 && isRunning) {
      statusBar.textContent = `Chờ ${delayEl.value}s trước ảnh tiếp theo...`;
      await sleep(delay);
    }
  }

  if (isRunning) statusBar.textContent = `✅ Hoàn thành ${imageFiles.length} ảnh!`;
  isRunning = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
});

btnStop.addEventListener('click', () => {
  isRunning = false;
  statusBar.textContent = '⏹ Đã dừng.';
  btnStart.disabled = false;
  btnStop.disabled = true;
});

// --- Mở tab Gemini và chờ load xong ---
async function openGeminiTab() {
  // Đóng tab cũ nếu còn
  if (geminiTabId !== null) {
    try { await chrome.tabs.remove(geminiTabId); } catch (_) {}
    geminiTabId = null;
  }

  const tab = await chrome.tabs.create({ url: 'https://gemini.google.com/', active: true });
  const tabId = tab.id;

  // Chờ tab load complete
  await new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });

  // Chờ thêm để Gemini JS khởi động xong
  await sleep(3000);
  return tabId;
}

// --- Gửi lệnh tới content script ---
async function sendToGeminiTab(tabId, dataUrl, mimeType, prompt, timeout, fileName) {
  // Inject content script (idempotent)
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await sleep(300);

  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ success: false, error: 'Timeout - Gemini gen quá lâu' }),
      timeout + 10000
    );

    chrome.tabs.sendMessage(tabId, { action: 'processImage', dataUrl, mimeType, prompt, timeout, fileName }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
      } else if (!response) {
        resolve({ success: false, error: 'Content script không phản hồi' });
      } else {
        resolve(response);
      }
    });
  });
}

// --- Helpers ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
