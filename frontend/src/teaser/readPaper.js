export async function readPaper(file) {
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose a file smaller than 15 MB.');
  if (/\.(txt|md)$/i.test(file.name)) return file.text();
  if (!/\.pdf$/i.test(file.name)) throw new Error('Choose a PDF, TXT, or Markdown file.');
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 150) throw new Error('Use a paper with 150 pages or fewer, or paste the relevant sections.');
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      pages.push(items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''));
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw new Error('This PDF has no selectable text. Paste a transcription; scanned PDFs need OCR.');
    return text;
  } finally { await task.destroy(); }
}
