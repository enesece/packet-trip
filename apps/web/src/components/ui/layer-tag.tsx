import type { LayerId } from '@packet-trip/engine';
import { useTranslation } from 'react-i18next';
import { layerTint, layerText } from '../../design/layer-colors';

/** Filled or outlined tag in a layer's color. */
export function LayerTag({
  layer,
  children,
  filled = false,
  className = '',
}: {
  layer: LayerId;
  children: React.ReactNode;
  filled?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`tag ${className}`}
      style={
        filled
          ? { background: layerText(layer), color: 'var(--tag-fg)' }
          : {
              background: layerTint(layer, 10),
              color: layerText(layer),
              boxShadow: `inset 0 0 0 1px ${layerTint(layer, 35)}`,
            }
      }
    >
      {children}
    </span>
  );
}

export function LayerName({ layer }: { layer: LayerId }) {
  const { t } = useTranslation();
  return <>{t(`layer.${layer}`)}</>;
}
