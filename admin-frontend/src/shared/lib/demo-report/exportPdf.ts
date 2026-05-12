import { toCanvas } from 'html-to-image';
import { jsPDF } from 'jspdf';

export async function exportReportPdf(root: HTMLDivElement) {
  const details = Array.from(root.querySelectorAll('details')) as HTMLDetailsElement[];
  const wasOpen = details.map((d) => d.open);
  details.forEach((d) => {
    d.open = true;
  });

  const header = document.createElement('div');
  header.className = 'demo-export-pdf-header';
  header.setAttribute('aria-hidden', 'true');

  const brand = document.createElement('div');
  brand.textContent = 'Sales Boost';
  brand.style.fontFamily = 'Pacifico, cursive';
  brand.style.fontSize = '34px';
  brand.style.color = '#e54d42';
  brand.style.marginBottom = '12px';

  const title = document.createElement('div');
  title.textContent = 'Узнайте, выдерживает ли ваш бизнес первый разговор';
  title.style.fontFamily = 'Inter, system-ui, sans-serif';
  title.style.fontWeight = '600';
  title.style.fontSize = '18px';
  title.style.lineHeight = '1.25';
  title.style.letterSpacing = '-0.02em';
  title.style.color = '#000';
  title.style.marginBottom = '20px';

  header.appendChild(brand);
  header.appendChild(title);
  root.insertBefore(header, root.firstChild);

  try {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const canvas = await toCanvas(root, {
      pixelRatio: 2,
      cacheBust: true,
      backgroundColor: '#f7dc4f',
      filter: (el) => {
        if (!(el instanceof HTMLElement)) return true;
        if (el.classList.contains('demo-share-icon')) return false;
        return true;
      },
    });

    const imgData = canvas.toDataURL('image/png', 1.0);
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const marginMm = 10;
    const imgW = pageW - marginMm * 2;
    const imgH = (canvas.height * imgW) / canvas.width;
    const sliceH = pageH - marginMm * 2;

    let y = marginMm;
    pdf.addImage(imgData, 'PNG', marginMm, y, imgW, imgH);
    let heightLeft = imgH - sliceH;

    while (heightLeft > 0) {
      y = marginMm - (imgH - heightLeft);
      pdf.addPage();
      pdf.addImage(imgData, 'PNG', marginMm, y, imgW, imgH);
      heightLeft -= sliceH;
    }

    pdf.save('sales-boost-otchet.pdf');
  } finally {
    header.remove();
    details.forEach((d, i) => {
      d.open = wasOpen[i] ?? false;
    });
  }
}

