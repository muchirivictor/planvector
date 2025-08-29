import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.entry';

// Determine the worker URL from environment variables. The FRONTEND should
// define NEXT_PUBLIC_WORKER_URL pointing to the FastAPI service.
const WORKER_URL =
  process.env.NEXT_PUBLIC_WORKER_URL || process.env.WORKER_URL || '';

/**
 * Page for uploading and processing a floor plan. Supports PDF or image
 * uploads, scale calibration, vectorization via the worker API, and a
 * human review checkpoint before exporting results.
 */
export default function UploadPage() {
  const [user, setUser] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pxPerFt, setPxPerFt] = useState<number>(12);
  const [preview, setPreview] = useState<any>(null);
  const [originalImg, setOriginalImg] = useState<string>('');

  useEffect(() => {
    // Fetch the current user. If no user, supabase.auth.getUser will return null.
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
  }, []);

  /**
   * Convert an uploaded file to an array of PNG data URLs. If the input
   * file is a PDF, up to the first 5 pages are rendered to images. For
   * other image formats, the file is returned as a single URL.
   */
  async function fileToPNGDataURL(f: File): Promise<string[]> {
    if (f.type === 'application/pdf') {
      const arr = new Uint8Array(await f.arrayBuffer());
      const pdf = await (pdfjsLib as any).getDocument({ data: arr }).promise;
      const maxPages = Math.min(pdf.numPages, 5);
      const urls: string[] = [];
      for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: ctx, viewport }).promise;
        urls.push(canvas.toDataURL('image/png'));
      }
      return urls;
    } else {
      return [URL.createObjectURL(f)];
    }
  }

  /**
   * Handle file upload. Creates a plan record, uploads the first page to
   * Supabase Storage, calls the vectorization worker, stores the results,
   * and updates the plan status.
   */
  async function handleUpload() {
    if (!user || !file) return;
    const { data: planIns, error: planErr } = await supabase
      .from('plans')
      .insert({ user_id: user.id, name: file.name, page_count: 0 })
      .select()
      .single();
    if (planErr) {
      alert('DB plan error');
      return;
    }
    const planId = planIns.id;

    const dataUrls = await fileToPNGDataURL(file);
    const pageCount = dataUrls.length;

    // Upload the first page image to the plans bucket.
    const response = await fetch(dataUrls[0]);
    const blob = await response.blob();
    const path = `user-${user.id}/${planId}/page-1.png`;
    const uploadRes = await supabase.storage
      .from('plans')
      .upload(path, blob, { upsert: true });
    if (uploadRes.error) {
      alert('Storage upload failed');
      return;
    }
    const { data: pub } = supabase.storage.from('plans').getPublicUrl(path);
    const publicUrl = pub.publicUrl;
    setOriginalImg(publicUrl);

    // Call the worker to vectorize the image.
    const form = new FormData();
    form.append('image_url', publicUrl);
    form.append('px_per_ft', String(pxPerFt));
    const r = await fetch(`${WORKER_URL}/vectorize_url`, {
      method: 'POST',
      body: form,
    });
    const json = await r.json();
    setPreview(json);

    // Save the SVG to the outputs bucket.
    const svgBytes = atob(json.svg);
    const svgBlob = new Blob([svgBytes], { type: 'image/svg+xml' });
    const svgPath = `user-${user.id}/${planId}/page-1.svg`;
    const svgUp = await supabase.storage
      .from('outputs')
      .upload(svgPath, svgBlob, { upsert: true });
    if (svgUp.error) {
      alert('SVG store failed');
      return;
    }
    // Insert the outputs row.
    await supabase.from('outputs').insert({
      plan_id: planId,
      svg_path: svgPath,
      dxf_path: null,
      csv_path: null,
      metrics: json.metrics,
      confidence: json.confidence,
    });

    // Update the plan status and page count.
    await supabase
      .from('plans')
      .update({ page_count: pageCount, status: 'processed' })
      .eq('id', planId);
    alert('Processed. Review below.');
  }

  /**
   * Approve the results and export a CSV summarizing the quantities. This
   * function records the review, deducts a credit, saves a CSV to
   * Supabase Storage, and links it to the output record.
   */
  async function approveExport() {
    if (!user || !preview) return;
    const { data: latestPlan } = await supabase
      .from('plans')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (!latestPlan) return;
    // Record the approval and credit usage.
    await supabase.from('reviews').insert({ plan_id: latestPlan.id, status: 'approved' });
    await supabase.from('usage_ledger').insert({
      user_id: user.id,
      plan_id: latestPlan.id,
      event: 'export_approved',
      delta_credits: -1,
    });
    // Build a CSV string.
    const csv = `metric,value\nwalls_len_ft,${preview.metrics.walls_len_ft}\nline_count,${preview.metrics.line_count}\n`;
    const csvBlob = new Blob([csv], { type: 'text/csv' });
    const csvPath = `user-${user.id}/${latestPlan.id}/page-1.csv`;
    const up = await supabase.storage
      .from('outputs')
      .upload(csvPath, csvBlob, { upsert: true });
    if (!up.error) {
      await supabase.from('outputs').update({ csv_path: csvPath }).eq('plan_id', latestPlan.id);
      alert('Approved & exported CSV.');
    }
  }

  // Redirect unauthenticated users to the login page.
  if (!user) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    return null;
  }

  return (
    <div style={{ padding: 24 }}>
      <h2>Upload a plan (PDF up to 5 pages, or an image)</h2>
      <input
        type='file'
        accept='application/pdf,image/*'
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />
      <div style={{ marginTop: 8 }}>
        <label>Scale (pixels per foot): </label>
        <input
          type='number'
          value={pxPerFt}
          onChange={(e) => setPxPerFt(Number(e.target.value))}
        />
      </div>
      <button onClick={handleUpload} style={{ marginTop: 12 }}>
        Process First Page
      </button>

      {preview && (
        <>
          <h3 style={{ marginTop: 24 }}>Review (Human Checkpoint)</h3>
          <div style={{ display: 'flex', gap: 16 }}>
            <div>
              <div>Original</div>
              {originalImg && (
                <img
                  src={originalImg}
                  style={{ maxWidth: 400, border: '1px solid #ccc' }}
                />
              )}
            </div>
            <div>
              <div>Detected Vectors (SVG)</div>
              <div
                style={{ maxWidth: 400, border: '1px solid #ccc' }}
                dangerouslySetInnerHTML={{ __html: atob(preview.svg) }}
              />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div>Confidence: {preview.confidence}</div>
            <div>Walls length (ft): {preview.metrics.walls_len_ft}</div>
            <button onClick={approveExport} style={{ marginTop: 8 }}>
              Approve & Export CSV
            </button>
          </div>
        </>
      )}
    </div>
  );
}
