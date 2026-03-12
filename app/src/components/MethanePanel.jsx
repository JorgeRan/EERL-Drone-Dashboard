import React from 'react'
import { tw , color } from '../constants/tailwind'
import { FlowChart } from "./FlowChart";

export function MethanePanel() {
    return (
        <div className={tw.panel} style={{ backgroundColor: color.card, padding: '0.75rem' }}>
          <div className='grid h-full w-full gap-3'>
            <FlowChart sensor="sensor1" />
          </div>
        </div>
    );
}

