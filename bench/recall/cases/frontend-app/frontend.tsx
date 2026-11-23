// Deliberately flawed multi-framework frontend fixture (React, Angular, Vue, Vanilla DOM) for Loadwise recall testing.
// Scanned read-only by bench/recall/runner.cjs; never executed.
import _ from 'lodash';
import React, { memo, useEffect } from 'react';
import { h, onMounted } from 'vue';
import { Component } from '@angular/core';
import { interval } from 'rxjs';
import { DomSanitizer } from '@angular/platform-browser';

const ChildCard = memo(function ChildCard(props: { config: Record<string, unknown> }) {
  return <p>{Object.keys(props.config).length}</p>;
});

export function ReactWidget({ items, userHtml, userId }: { items: any[]; userHtml: string; userId: string }) {
  useEffect(() => {
    window.addEventListener('resize', () => console.log('resized'));
  }, []);

  useEffect(() => {
    fetch(`/api/users/${userId}`).then((r) => r.json());
  }, [userId]);

  return (
    <div>
      <ChildCard config={{ dense: true, showHeader: true, maxRows: 10 }} />
      <div dangerouslySetInnerHTML={{ __html: userHtml }} />
      {items.map((item, idx) => (
        <span key={idx}>{item.name}</span>
      ))}
    </div>
  );
}

@Component({ selector: 'app-profile', template: '<p>Profile</p>' })
export class ProfileComponent {
  constructor(private sanitizer: DomSanitizer) {}
  ngOnInit() {
    interval(1000).subscribe((tick) => console.log(tick));
  }
  renderBio(bio: string) {
    return this.sanitizer.bypassSecurityTrustHtml(bio);
  }
}

export function setupVueComponent(items: any[], bioHtml: string) {
  onMounted(() => {
    window.setInterval(() => console.log('tick'), 1000);
  });
  const list = items.map((item) => h('li', { class: 'row' }, item.name));
  const box = h('div', { innerHTML: bioHtml });
  return { list, box };
}

export function vanillaDomWork(elements: HTMLElement[], userInput: string, authToken: string) {
  for (let i = 0; i < elements.length; i++) {
    const height = elements[i].offsetHeight;
    elements[i].style.height = `${height + 10}px`;
  }
  window.addEventListener('scroll', () => console.log('scrolling'));
  document.getElementById('out')!.innerHTML = userInput;
  localStorage.setItem('access_token', authToken);
  window.postMessage({ ok: true }, '*');
  window.addEventListener('message', (event: any) => {
    console.log(event.data);
  });
  return _.camelCase(userInput);
}
