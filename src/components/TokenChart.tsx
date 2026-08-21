import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"; // Assuming shadcn Card is installed

// Type for the data expected by the chart (from getBars)
// Adjust based on actual getBars response structure
export interface ChartDataPoint {
  time: number; // Assuming timestamp
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  // Add other fields like volume if needed
}

interface TokenChartProps {
  data: ChartDataPoint[];
  title?: string;
}

export const TokenChart: React.FC<TokenChartProps> = ({
  data,
  title = "Price Chart",
}) => {
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">No chart data available.</p>
        </CardContent>
      </Card>
    );
  }

  // Format timestamp for XAxis
  const formatXAxis = (tickItem: number) => {
    return new Date(tickItem * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  // Format tooltip value
  const formatTooltipValue = (value: number) => {
    return value.toFixed(4); // Adjust precision as needed
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[clamp(220px,35vh,300px)]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{
                top: 5,
                right: 30,
                left: 20,
                bottom: 5,
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="time"
                tickFormatter={formatXAxis}
                stroke="#AAAAAA"
                fontSize={12}
                tickLine={true}
                axisLine={false}
              />
              <YAxis
                stroke="#AAAAAA"
                fontSize={12}
                tickLine={true}
                axisLine={false}
                tickFormatter={(value) => `$${value.toFixed(2)}`}
                domain={["auto", "auto"]}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--background)",
                  borderColor: "var(--border)",
                  color: "var(--foreground)",
                }}
                labelFormatter={formatXAxis}
                formatter={formatTooltipValue}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="open"
                stroke="#60A5FA"
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="high"
                stroke="#34D399"
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="low"
                stroke="#F59E0B"
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="close"
                stroke="#FFFFFF"
                activeDot={{ r: 8 }}
                dot={true}
                connectNulls
              />
              {/* Add lines for open, high, low if needed */}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
};
