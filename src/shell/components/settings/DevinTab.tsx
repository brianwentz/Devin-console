import { CloudTab } from './CloudTab';
import { LocalTab } from './LocalTab';
import { sectionHeadingClass, sectionSeparatorClass } from './styles';

export function DevinTab() {
  return (
    <>
      <section data-settings-section="devin-cloud">
        <h3 className={sectionHeadingClass}>Devin Cloud</h3>
        <CloudTab />
      </section>
      <section data-settings-section="devin-local" className={sectionSeparatorClass}>
        <h3 className={sectionHeadingClass}>Devin Local</h3>
        <LocalTab />
      </section>
    </>
  );
}
