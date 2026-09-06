import { Children, useId, useState, type ReactNode } from "react";

export function DetailTabs({ label, tabs, children }: { label: string; tabs: string[]; children: ReactNode }) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  const panels = Children.toArray(children);
  return <div className="detail-tabs">
    <div className="detail-tab-list" role="tablist" aria-label={label} onKeyDown={(event) => {
      let next = selected;
      if (event.key === "ArrowRight") next = (selected + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (selected + tabs.length - 1) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      setSelected(next);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>
      {tabs.map((tab, index) => <button key={tab} type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={selected === index} tabIndex={selected === index ? 0 : -1} onClick={() => setSelected(index)}>{tab}</button>)}
    </div>
    <div className="detail-tab-panels">
      {panels.map((panel, index) => <div key={index} role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={selected !== index} tabIndex={0}>{panel}</div>)}
    </div>
  </div>;
}