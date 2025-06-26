import type{ ModuleOption } from '../types';
import { BuildingBlockRegistry } from './registry';

export function resolveModule<T>(moduleType: keyof typeof BuildingBlockRegistry, option?: ModuleOption<T>): T {
  if (typeof option === 'object' && option !== null) {
    return option as T;
  }
  
  const key = (typeof option === 'string') ? option : 'default';
  // @ts-expect-error - TODO: fix this
  const factory = (BuildingBlockRegistry)[moduleType][key];

  if (!factory) {
    throw new Error(`Unknown building block '${key}' for module type '${moduleType}'.`);
  }

  return factory() as T;
} 