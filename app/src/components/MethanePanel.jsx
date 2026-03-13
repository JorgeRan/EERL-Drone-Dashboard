import React from 'react'
import { tw , color } from '../constants/tailwind'
import { FlowChart } from "./FlowChart";

export function MethanePanel({ flowData, selection, onSelectionChange }) {
    return (
        <div className={tw.panel} style={{ backgroundColor: color.card, padding: '0.75rem' }}>
          <div className='h-full w-full'>
            <FlowChart
              flowData={flowData}
              selection={selection}
              onSelectionChange={onSelectionChange}
            />
          </div>
        </div>
    );
}

