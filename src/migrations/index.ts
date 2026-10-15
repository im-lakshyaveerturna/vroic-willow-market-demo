import * as migration_20261013_101157_initial from './20261013_101157_initial';
import * as migration_20261014_120000_vroic_owned_state from './20261014_120000_vroic_owned_state';

export const migrations = [
  {
    up: migration_20261013_101157_initial.up,
    down: migration_20261013_101157_initial.down,
    name: '20261013_101157_initial'
  },
  {
    up: migration_20261014_120000_vroic_owned_state.up,
    down: migration_20261014_120000_vroic_owned_state.down,
    name: '20261014_120000_vroic_owned_state'
  },
];
