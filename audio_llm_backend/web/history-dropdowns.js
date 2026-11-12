(() => {
  const dropdowns = [];

  for (const id of ['history-filter', 'history-sort']) {
    const select = document.getElementById(id);
    if (!select) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'history-dropdown';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'history-dropdown-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${id}-options`);
    const label = document.createElement('span');
    trigger.append(label);
    const menu = document.createElement('div');
    menu.id = `${id}-options`;
    menu.className = 'history-dropdown-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', select.getAttribute('aria-label'));
    menu.hidden = true;
    select.before(wrapper);
    wrapper.append(select, trigger, menu);

    const choices = Array.from(select.options, (option) => {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = 'history-dropdown-option';
      choice.textContent = option.textContent;
      choice.setAttribute('role', 'option');
      choice.tabIndex = -1;
      choice.disabled = option.disabled;
      choice.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        close(true);
      });
      menu.append(choice);
      return choice;
    });

    function sync() {
      label.textContent = select.selectedOptions[0]?.textContent || '';
      trigger.setAttribute('aria-label', `${select.getAttribute('aria-label')}：${label.textContent}`);
      choices.forEach((choice, index) => choice.setAttribute('aria-selected', String(index === select.selectedIndex)));
    }
    function close(restoreFocus = false) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }
    function open() {
      dropdowns.forEach((dropdown) => dropdown.close());
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      (choices[select.selectedIndex] || choices[0])?.focus({ preventScroll: true });
    }
    trigger.addEventListener('click', () => menu.hidden ? open() : close(true));
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        open();
      }
    });
    menu.addEventListener('keydown', (event) => {
      const index = choices.indexOf(document.activeElement);
      const enabled = choices.filter((choice) => !choice.disabled);
      const position = enabled.indexOf(choices[index]);
      let next;
      if (event.key === 'ArrowDown') next = enabled[(position + 1) % enabled.length];
      if (event.key === 'ArrowUp') next = enabled[(position - 1 + enabled.length) % enabled.length];
      if (event.key === 'Home') next = enabled[0];
      if (event.key === 'End') next = enabled[enabled.length - 1];
      if (next) { event.preventDefault(); next.focus({ preventScroll: true }); }
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    });
    wrapper.addEventListener('focusout', (event) => {
      if (!wrapper.contains(event.relatedTarget)) close();
    });
    select.addEventListener('change', sync);
    dropdowns.push({ wrapper, close });
    sync();
    select.hidden = true;
  }

  document.addEventListener('click', (event) => {
    dropdowns.forEach((dropdown) => {
      if (!dropdown.wrapper.contains(event.target)) dropdown.close();
    });
  });
})();
