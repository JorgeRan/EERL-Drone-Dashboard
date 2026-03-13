import { useMemo, useState } from "react";
import { tw, color } from "./constants/tailwind";
import { DeviceTabs } from "./components/Tabs";
import { MethanePanel } from "./components/MethanePanel";
import { Map } from "./components/Map";
import { WindPanel } from "./components/WindPanel";
import { Position } from "./components/3DPosition";
import { flowChartData, methaneTraceDataset, sliceTraceDataset } from "./data/methaneTraceData";

let devices = [
  {
    id: "device1",
    name: "M350",
    type: "Drone",
    status: "online",
  },
  {
    id: "device2",
    name: "M400-1",
    type: "Drone",
    status: "offline",
  },
  {
    id: "device3",
    name: "M400-2",
    type: "Drone",
    status: "warning",
  },
];

function App() {
  const [selectedWindow, setSelectedWindow] = useState({
    startIndex: 0,
    endIndex: flowChartData.length - 1,
  });

  const filteredTraceDataset = useMemo(
    () => sliceTraceDataset(methaneTraceDataset, selectedWindow.startIndex, selectedWindow.endIndex),
    [selectedWindow],
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#f8fafc] text-slate-900 font-sans">
      <DeviceTabs devices={devices} />
      <main
        className={`flex-1 bg-slate-100 ${color.text}`}
        style={{ backgroundColor: color.background, color: color.text }}
      >
        <section className={tw.shell}>
          <div className="grid w-full gap-3">
            <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]">
              <Map traceDataset={filteredTraceDataset} />
              <Position traceDataset={filteredTraceDataset} />
            </div>
            <div className="grid w-full gap-3 xl:grid-cols-[1.4fr_0.8fr]">
              <MethanePanel
                flowData={flowChartData}
                selection={selectedWindow}
                onSelectionChange={setSelectedWindow}
              />
              <WindPanel/>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
