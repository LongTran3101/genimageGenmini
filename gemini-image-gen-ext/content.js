/**
 * Content script chạy trên gemini.google.com
 */

// Tránh đăng ký listener nhiều lần khi bị inject lại
if (!window.__geminiAutoGenLoaded) {
  window.__geminiAutoGenLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'processImage') {
      handleProcess(msg).then(sendResponse);
      return true;
    }
  });
}

async function handleProcess({ dataUrl, mimeType, prompt, timeout, fileName }) {
  try {
    log('Bắt đầu xử lý ảnh: ' + fileName);

    // Đếm số ảnh gen hiện có TRƯỚC khi gửi
    const existingCount = document.querySelectorAll('generated-image').length;
    log('Số ảnh gen hiện có: ' + existingCount);

    // 1. Upload ảnh
    await uploadImage(dataUrl, mimeType);

    // 2. Chờ attachment xuất hiện
    await waitForAttachment();

    // 3. Nhập prompt
    await typePrompt(prompt);
    await sleep(500);

    // 4. Gửi
    await submitPrompt();
    log('Đã gửi, đang chờ Gemini gen ảnh mới...');

    // 5. Chờ ảnh MỚI (nhiều hơn existingCount)
    const imgEl = await waitForNewGeneratedImage(existingCount, timeout);
    if (!imgEl) return { success: false, error: 'Timeout - không thấy ảnh mới được gen' };

    log('Ảnh mới đã gen xong, chờ 10s để UI ổn định rồi download...');
    await sleep(20000); // Đã giảm từ 20s xuống 10s vì hàm download mới có logic chờ riêng

    // 6. Download
    const baseName = (fileName || 'gemini').replace(/\.[^.]+$/, '');
    await downloadImage(imgEl, baseName);

    await sleep(5000);
    return { success: true };
  } catch (err) {
    log('Lỗi: ' + err.message);
    return { success: false, error: err.message };
  }
}

// --- Chờ send button enabled = attachment đã xong ---
async function waitForAttachment() {
  log('Chờ attachment upload xong...');
  for (let i = 0; i < 60; i++) {
    const sendBtn = document.querySelector(
      'button.send-button:not([aria-disabled="true"]), button.submit:not([aria-disabled="true"])'
    );
    if (sendBtn) {
      log('Attachment sẵn sàng (send button enabled)');
      await sleep(300);
      return;
    }
    await sleep(300);
  }
  log('Timeout chờ attachment, tiếp tục...');
}

// --- Reset về chat mới và chờ sẵn sàng ---
async function resetChat() {
  const newChatSelectors = [
    'a[href="/"][aria-label*="new" i]',
    'a[href="/"][aria-label*="mới" i]',
    'a[href="/"].new-chat-button',
    'button[aria-label*="new chat" i]',
    'a[href="/"]',
  ];
  for (const sel of newChatSelectors) {
    const el = document.querySelector(sel);
    if (el) { el.click(); break; }
  }

  // Chờ editor sẵn sàng và trống
  for (let i = 0; i < 20; i++) {
    const editor = document.querySelector('div.ql-editor[contenteditable="true"]');
    if (editor) {
      // Đảm bảo không còn attachment cũ
      const attachments = document.querySelectorAll(
        'uploader img, .upload-preview, .file-preview, [data-test-id*="upload-thumbnail"]'
      );
      if (attachments.length === 0) {
        log('Chat mới sẵn sàng');
        return;
      }
    }
    await sleep(500);
  }
}

// --- Upload ảnh bằng clipboard paste ---
async function uploadImage(dataUrl, mimeType) {
  const file = dataUrlToFile(dataUrl, `upload_${Date.now()}.${mimeType.split('/')[1] || 'png'}`, mimeType);

  const editor = document.querySelector('div.ql-editor[contenteditable="true"]');
  if (!editor) throw new Error('Không tìm thấy editor');

  editor.focus();
  await sleep(200);

  const dt = new DataTransfer();
  dt.items.add(file);

  const pasteEvent = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });
  editor.dispatchEvent(pasteEvent);
  log('Upload qua clipboard paste');
}

// --- Nhập prompt vào ql-editor ---
async function typePrompt(text) {
  const editor = document.querySelector('div.ql-editor[contenteditable="true"]');
  if (!editor) throw new Error('Không tìm thấy ô nhập prompt (ql-editor)');

  editor.focus();
  // Xóa nội dung cũ
  editor.innerHTML = '<p><br></p>';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);

  // Dùng execCommand để insert text (hoạt động với contenteditable)
  const sel = window.getSelection();
  const range = document.createRange();
  const p = editor.querySelector('p') || editor;
  range.selectNodeContents(p);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);

  document.execCommand('insertText', false, text);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  log('Đã nhập prompt');
}

// --- Submit ---
async function submitPrompt() {
  // Chờ send button enabled
  let sendBtn = null;
  for (let i = 0; i < 20; i++) {
    sendBtn = document.querySelector('button.send-button.submit:not([aria-disabled="true"])');
    if (sendBtn) break;
    await sleep(300);
  }

  if (sendBtn) {
    sendBtn.click();
    log('Đã click send button');
  } else {
    // Fallback: Enter key
    const editor = document.querySelector('div.ql-editor[contenteditable="true"]');
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      log('Đã gửi bằng Enter');
    } else {
      throw new Error('Không tìm thấy send button');
    }
  }
}

// --- Chờ ảnh MỚI gen xong (nhiều hơn existingCount) ---
async function waitForNewGeneratedImage(existingCount, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const allGenImages = document.querySelectorAll('generated-image');
    if (allGenImages.length > existingCount) {
      // Lấy generated-image mới nhất
      const newest = allGenImages[allGenImages.length - 1];
      // Chờ img bên trong load xong
      const img = newest.querySelector('img.image');
      if (img && img.src) {
        log('Tìm thấy ảnh gen mới (total: ' + allGenImages.length + ')');
        return img;
      }
    }
    await sleep(1000);
  }
  return null;
}

// --- 6. Download (Đã tối ưu để lấy ảnh native chất lượng cao) ---
async function downloadImage(imgEl, baseName) {
  log('[DL] Bắt đầu quá trình download chất lượng cao...');

  // Cuộn tới ảnh để đảm bảo nó được render đầy đủ trên DOM
  imgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await sleep(1500); // Chờ 1.5 giây sau khi cuộn

  // --- CHIẾN LƯỢC 1: TẤN CÔNG ĐỂ CLICK NÚT NATIVE ---
  const isNativeClicked = await tryHighQualityNativeDownload(imgEl);
  
  if (isNativeClicked) {
    log('[DL] Hoàn tất qua nút click native của trang. Trình duyệt sẽ tải ảnh gốc.');
    return;
  }

  // --- CHIẾN LƯỢC 2 (CUỐI CÙNG): FALLBACK BLOB ---
  log('[DL] Không thể click native, fallback sang blob... (có thể chất lượng thấp hơn)');
  await downloadViaBlob(imgEl, baseName);
}

// Cố gắng mọi cách để tìm và click nút tải về native của trang
async function tryHighQualityNativeDownload(imgEl) {
  try {
    // 1. Khoanh vùng thẻ <generated-image> chứa ảnh mới nhất
    const genImgContainer = imgEl.closest('generated-image');
    if (!genImgContainer) {
      log('[DL] Không tìm thấy thẻ bao ngoài <generated-image> cho ảnh này.');
      return false;
    }

    // 2. GIẢ LẬP HOVER vào container để hiện nút (RẤT QUAN TRỌNG)
    const hoverEvent = new MouseEvent('mouseover', {
      view: window,
      bubbles: true,
      cancelable: true
    });
    genImgContainer.dispatchEvent(hoverEvent);
    log('[DL] Đã giả lập Hover vào container để kích hoạt nút download.');
    
    // Chờ 1 giây để UI load nút sau khi hover
    await sleep(1000); 

    // 3. Tấn công đa điểm: Tìm mọi selector có khả năng CHỈ BÊN TRONG container này
    let downloadBtn = null;

    // Selector ưu tiên số 1 (data-test-id chuẩn của Gemini)
    downloadBtn = genImgContainer.querySelector('button[data-test-id="download-generated-image-button"]');

    // Selector dự phòng (aria-label)
    if (!downloadBtn) {
        downloadBtn = genImgContainer.querySelector('button[aria-label*="download" i]') || 
                      genImgContainer.querySelector('button[aria-label*="tải xuống" i]');
    }

    // Selector dự phòng cuối cùng (biểu tượng tải xuống)
    if (!downloadBtn) {
        const svgDownload = genImgContainer.querySelector('svg[aria-label*="download" i]') ||
                            genImgContainer.querySelector('mat-icon[role="img"][aria-label*="download" i]');
        if (svgDownload) {
            downloadBtn = svgDownload.closest('button');
        }
    }

    // 4. Thực hiện CLICK
    if (downloadBtn) {
        downloadBtn.click();
        log('[DL] Đã click nút tải native thành công.');
        return true; 
    } else {
        log('[DL] Hover xong không tìm thấy nút download nào trong container.');
        return false;
    }

  } catch (err) {
    log('[DL] Lỗi trong quá trình native download: ' + err.message);
    return false;
  }
}

// Fallback tải ảnh trực tiếp qua Blob (chất lượng preview)
async function downloadViaBlob(imgEl, baseName) {
  const src = imgEl.src;
  if (!src) throw new Error('img.src rỗng, không thể download');

  // Fetch ảnh thành blob URL
  const resp = await fetch(src);
  if (!resp.ok) throw new Error('Fetch ảnh thất bại: ' + resp.status);

  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);

  const filename = (baseName || 'gemini') + '_' + Date.now() + '.png';

  // Dùng thẻ <a> download
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Giải phóng blob URL sau 5s
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
  log('Đã download qua blob: ' + filename + ' (chất lượng preview)');
}

// --- Các hàm hỗ trợ ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg) { console.log('[GeminiAutoGen]', msg); }

function dataUrlToFile(dataUrl, filename, mimeType) {
  const arr = dataUrl.split(',');
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new File([u8arr], filename, { type: mimeType });
}