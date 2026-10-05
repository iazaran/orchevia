import '@testing-library/jest-dom/vitest';

import { createElement } from 'react';
import { beforeEach, expect } from 'vitest';
import { render } from '@testing-library/react';
import { NoticeHost } from '../components/Notice';
import { useAppStore } from '../store';

beforeEach(() => {
  useAppStore.setState({ uiNotices: [] });
  if (expect.getState().testPath?.includes('/components/'))
    render(createElement(NoticeHost));
});
