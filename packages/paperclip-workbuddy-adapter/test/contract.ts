import type { ServerAdapterModule } from '@paperclipai/adapter-utils';
import { createServerAdapter } from '../src/index.js';
const adapter: ServerAdapterModule = createServerAdapter();
void adapter;
