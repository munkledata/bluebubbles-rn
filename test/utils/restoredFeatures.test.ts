/**
 * restoredIMessageFeaturesLabel (src/utils/restoredFeatures.ts): the About / Server Management status
 * line that replaced "Private API: Retired in this release".
 */
import { restoredIMessageFeaturesLabel } from '@utils';

describe('restoredIMessageFeaturesLabel', () => {
  it('reads On when the server routes any restored feature', () => {
    expect(
      restoredIMessageFeaturesLabel({
        server_version: '2.0.47',
        supports_imessage_group_edit: true,
        supports_imessage_group_unsend: false,
      }),
    ).toBe('On');
  });

  it('reads Off when the server lists the switches but all are off', () => {
    expect(
      restoredIMessageFeaturesLabel({
        server_version: '2.0.47',
        supports_imessage_group_edit: false,
        supports_imessage_group_reactions: false,
      }),
    ).toBe('Off');
  });

  it('reads Not on this server for an older server that lists none of them', () => {
    expect(restoredIMessageFeaturesLabel({ server_version: '1.9.9' })).toBe('Not on this server');
  });

  it('shows a dash until the server details load', () => {
    expect(restoredIMessageFeaturesLabel(null)).toBe('—');
    expect(restoredIMessageFeaturesLabel(undefined)).toBe('—');
  });
});
