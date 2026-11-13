/**
 * Hand a text file to the browser as a download. Everything happens in the page: the file is built from data already in the page,
 * and nothing is sent anywhere.
 */
export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the temporary address is released.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
