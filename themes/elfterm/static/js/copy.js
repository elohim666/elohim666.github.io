document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.highlight, article > pre').forEach(function(block) {
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '[copy]';
    btn.addEventListener('click', function() {
      var code = block.querySelector('code');
      if (!code) return;
      var text = code.textContent.trim();
      text = text.split('\n').map(function(line) {
        return line.replace(/^\s*\$\s?/, '');
      }).join('\n').trim();
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = '[copied]';
        setTimeout(function() { btn.textContent = '[copy]'; }, 1500);
      });
    });
    block.appendChild(btn);
  });
});
