document.querySelectorAll('.command').forEach(block => {
  const button = block.querySelector('button');
  const code = block.querySelector('code');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = '已複製';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = '已選取，請手動複製';
    }
  });
});
