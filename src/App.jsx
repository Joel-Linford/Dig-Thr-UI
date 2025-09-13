import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";

/**
 * RadialTreeExplorer (Stable build)
 * ------------------------------------------------------------
 * React + D3 radial tree inspired by https://observablehq.com/@d3/radial-tree/2
 *
 * New in this revision:
 *  - Sidebar now surfaces **Requirements**, **Related System Blocks**, and **Metadata** from the full dataset for the selected node.
 *  - Keeps prior fixes (dblclick zoom disabled, selection preserved across focus, breadcrumbs use full data).
 *  - Added runtime tests around requirements/blocks extraction.
 *
 * UX:
 *  - Scroll/trackpad to zoom, drag to pan
 *  - Single‑click a node → select and show details in side panel
 *  - Double‑click a node → re‑root (focus) the tree at that node (selection preserved)
 *  - Breadcrumbs (from FULL dataset) are clickable to focus ancestors
 *  - "Reset root" → returns to original data root
 *
 * Usage:
 *   <RadialTreeExplorer data={yourHierarchyObjectOrJSONString} />
 *   If no data is provided, the classic `flare` dataset below is used.
 */

// ------------------------------------------------------------
// Utilities
// ------------------------------------------------------------
const safeClone = (obj) => {
  if (typeof structuredClone === "function") return structuredClone(obj);
  // Fallback deep clone (sufficient for plain objects/arrays like our data)
  return JSON.parse(JSON.stringify(obj));
};

const coerceHierarchyInput = (input) => {
  if (!input) return null;
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (e) {
      console.error("Failed to parse data JSON string.", e);
      return null;
    }
  }
  if (typeof input === "object") return input;
  return null;
};

const asArray = (v) => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------
// Depth limiting helpers
// ------------------------------------------------------------
const MAX_DEPTH = 2; // visible tiers from current focus (root depth=0)
const LABEL_RADIAL_PAD_BASE = 8;  // base radial push for labels (px)
const LABEL_RADIAL_PAD_EXTRA = 10; // extra push near top/bottom (scaled by |sin(theta)|)

/**
 * limitDepth
 * Returns a deep-cloned subtree limited to `maxDepth` from the given node.
 * Adds `_pathIdxs` (array of child indices from focus) for each node so we can
 * map a visible/pruned node back to the original full dataset.
 * Adds `_hasHidden` when deeper content exists beyond the current window.
 */
const limitDepth = (node, maxDepth, depth = 0, pathIdxs = []) => {
  if (!node || typeof node !== "object") return node;
  const copy = { name: node.name };
  copy._pathIdxs = pathIdxs;
  if ("value" in node) copy.value = node.value;

  const hasKids = Array.isArray(node.children) && node.children.length > 0;
  if (!hasKids) return copy;

  if (depth >= maxDepth) {
    copy._hasHidden = hasKids;
    return copy;
  }

  copy.children = node.children.map((c, i) => limitDepth(c, maxDepth, depth + 1, [...pathIdxs, i]));
  // Mark if deeper content exists and we're exposing the last visible tier
  if (node.children.some((c) => Array.isArray(c.children) && c.children.length > 0)) {
    if (depth + 1 >= maxDepth) copy._hasHidden = true;
  }
  return copy;
};

// ------------------------------------------------------------
// Path helpers (operate on FULL data)
// ------------------------------------------------------------
const getNodeByPathIdxs = (root, idxs) => {
  if (!Array.isArray(idxs) || idxs.length === 0) return root;
  let cur = root;
  for (const i of idxs) {
    if (!cur || !Array.isArray(cur.children) || i < 0 || i >= cur.children.length) return null;
    cur = cur.children[i];
  }
  return cur;
};

const getAbsolutePathIdxs = (focusPathIdxs, maybePath) => {
  const rel = Array.isArray(maybePath) ? maybePath : [];
  return [...focusPathIdxs, ...rel];
};

const getOriginalFromPrunedNode = (root, focusPathIdxs, prunedNode) => {
  if (!prunedNode || !prunedNode.data) return null;
  const abs = getAbsolutePathIdxs(focusPathIdxs, prunedNode.data._pathIdxs);
  return getNodeByPathIdxs(root, abs);
};

// Clip a target absolute path to a relative path within the current focus and depth window
const clipRelPathToDepth = (focusPath, targetAbs, maxDepth) => {
  const rel = Array.isArray(targetAbs) ? targetAbs.slice(focusPath.length) : [];
  return rel.slice(0, maxDepth);
};

// ------------------------------------------------------------
// Full-tree statistics
// ------------------------------------------------------------
const sumValuesDeep = (node) => {
  if (!node) return 0;
  let total = 0;
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (typeof cur.value === "number") total += cur.value;
    if (Array.isArray(cur.children)) stack.push(...cur.children);
  }
  return total;
};

const countLeavesDeep = (node) => {
  if (!node) return 0;
  let count = 0;
  const stack = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur.children) && cur.children.length) {
      stack.push(...cur.children);
    } else {
      count += 1;
    }
  }
  return count;
};

// ------------------------------------------------------------
// Default flare dataset (VALID object literal with closing braces + semicolon)
// Source: Mike Bostock's flare hierarchy
// ------------------------------------------------------------
const sampleData = {"name":"flare","children":[{"name":"analytics","children":[{"name":"cluster","children":[{"name":"AgglomerativeCluster","value":3938},{"name":"CommunityStructure","value":3812},{"name":"HierarchicalCluster","value":6714},{"name":"MergeEdge","value":743}]},{"name":"graph","children":[{"name":"BetweennessCentrality","value":3534},{"name":"LinkDistance","value":5731},{"name":"MaxFlowMinCut","value":7840},{"name":"ShortestPaths","value":5914},{"name":"SpanningTree","value":3416}]},{"name":"optimization","children":[{"name":"AspectRatioBanker","value":7074}]}]},{"name":"animate","children":[{"name":"Easing","value":17010},{"name":"FunctionSequence","value":5842},{"name":"interpolate","children":[{"name":"ArrayInterpolator","value":1983},{"name":"ColorInterpolator","value":2047},{"name":"DateInterpolator","value":1375},{"name":"Interpolator","value":8746},{"name":"MatrixInterpolator","value":2202},{"name":"NumberInterpolator","value":1382},{"name":"ObjectInterpolator","value":1629},{"name":"PointInterpolator","value":1675},{"name":"RectangleInterpolator","value":2042}]},{"name":"ISchedulable","value":1041},{"name":"Parallel","value":5176},{"name":"Pause","value":449},{"name":"Scheduler","value":5593},{"name":"Sequence","value":5534},{"name":"Transition","value":9201},{"name":"Transitioner","value":19975},{"name":"TransitionEvent","value":1116},{"name":"Tween","value":6006}]},{"name":"data","children":[{"name":"converters","children":[{"name":"Converters","value":721},{"name":"DelimitedTextConverter","value":4294},{"name":"GraphMLConverter","value":9800},{"name":"IDataConverter","value":1314},{"name":"JSONConverter","value":2220}]},{"name":"DataField","value":1759},{"name":"DataSchema","value":2165},{"name":"DataSet","value":586},{"name":"DataSource","value":3331},{"name":"DataTable","value":772},{"name":"DataUtil","value":3322}]},{"name":"display","children":[{"name":"DirtySprite","value":8833},{"name":"LineSprite","value":1732},{"name":"RectSprite","value":3623},{"name":"TextSprite","value":10066}]},{"name":"flex","children":[{"name":"FlareVis","value":4116}]},{"name":"physics","children":[{"name":"DragForce","value":1082},{"name":"GravityForce","value":1336},{"name":"IForce","value":319},{"name":"NBodyForce","value":10498},{"name":"Particle","value":2822},{"name":"Simulation","value":9983},{"name":"Spring","value":2213},{"name":"SpringForce","value":1681}]},{"name":"query","children":[{"name":"AggregateExpression","value":1616},{"name":"And","value":1027},{"name":"Arithmetic","value":3891},{"name":"Average","value":891},{"name":"BinaryExpression","value":2893},{"name":"Comparison","value":5103},{"name":"CompositeExpression","value":3677},{"name":"Count","value":781},{"name":"DateUtil","value":4141},{"name":"Distinct","value":933},{"name":"Expression","value":5130},{"name":"ExpressionIterator","value":3617},{"name":"Fn","value":3240},{"name":"If","value":2732},{"name":"IsA","value":2039},{"name":"Literal","value":1214},{"name":"Match","value":3748},{"name":"Maximum","value":843},{"name":"methods","children":[{"name":"add","value":593},{"name":"and","value":330},{"name":"average","value":287},{"name":"count","value":277},{"name":"distinct","value":292},{"name":"div","value":595},{"name":"eq","value":594},{"name":"fn","value":460},{"name":"gt","value":603},{"name":"gte","value":625},{"name":"iff","value":748},{"name":"isa","value":461},{"name":"lt","value":597},{"name":"lte","value":619},{"name":"max","value":283},{"name":"min","value":283},{"name":"mod","value":591},{"name":"mul","value":603},{"name":"neq","value":599},{"name":"not","value":386},{"name":"or","value":323},{"name":"orderby","value":307},{"name":"range","value":772},{"name":"select","value":296},{"name":"stddev","value":363},{"name":"sub","value":600},{"name":"sum","value":280},{"name":"update","value":307},{"name":"variance","value":335},{"name":"where","value":299},{"name":"xor","value":354},{"name":"_","value":264}]},{"name":"Minimum","value":843},{"name":"Not","value":1554},{"name":"Or","value":970},{"name":"Query","value":13896},{"name":"Range","value":1594},{"name":"StringUtil","value":4130},{"name":"Sum","value":791},{"name":"Variable","value":1124},{"name":"Variance","value":1876},{"name":"Xor","value":1101}]},{"name":"scale","children":[{"name":"IScaleMap","value":2105},{"name":"LinearScale","value":1316},{"name":"LogScale","value":3151},{"name":"OrdinalScale","value":3770},{"name":"QuantileScale","value":2435},{"name":"QuantitativeScale","value":4839},{"name":"RootScale","value":1756},{"name":"Scale","value":4268},{"name":"ScaleType","value":1821},{"name":"TimeScale","value":5833}]},{"name":"util","children":[{"name":"Arrays","value":8258},{"name":"Colors","value":10001},{"name":"Dates","value":8217},{"name":"Displays","value":12555},{"name":"Filter","value":2324},{"name":"Geometry","value":10993},{"name":"heap","children":[{"name":"FibonacciHeap","value":9354},{"name":"HeapNode","value":1233}]},{"name":"IEvaluable","value":335},{"name":"IPredicate","value":383},{"name":"IValueProxy","value":874},{"name":"math","children":[{"name":"DenseMatrix","value":3165},{"name":"IMatrix","value":2815},{"name":"SparseMatrix","value":3366}]},{"name":"Maths","value":17705},{"name":"Orientation","value":1486},{"name":"palette","children":[{"name":"ColorPalette","value":6367},{"name":"Palette","value":1229},{"name":"ShapePalette","value":2059},{"name":"SizePalette","value":2291}]},{"name":"Property","value":5559},{"name":"Shapes","value":19118},{"name":"Sort","value":6887},{"name":"Stats","value":6557},{"name":"Strings","value":22026}]},{"name":"vis","children":[{"name":"axis","children":[{"name":"Axes","value":1302},{"name":"Axis","value":24593},{"name":"AxisGridLine","value":652},{"name":"AxisLabel","value":636},{"name":"CartesianAxes","value":6703}]},{"name":"controls","children":[{"name":"AnchorControl","value":2138},{"name":"ClickControl","value":3824},{"name":"Control","value":1353},{"name":"ControlList","value":4665},{"name":"DragControl","value":2649},{"name":"ExpandControl","value":2832},{"name":"HoverControl","value":4896},{"name":"IControl","value":763},{"name":"PanZoomControl","value":5222},{"name":"SelectionControl","value":7862},{"name":"TooltipControl","value":8435}]},{"name":"data","children":[{"name":"Data","value":20544},{"name":"DataList","value":19788},{"name":"DataSprite","value":10349},{"name":"EdgeSprite","value":3301},{"name":"NodeSprite","value":19382},{"name":"render","children":[{"name":"ArrowType","value":698},{"name":"EdgeRenderer","value":5569},{"name":"IRenderer","value":353},{"name":"ShapeRenderer","value":2247}]},{"name":"ScaleBinding","value":11275},{"name":"Tree","value":7147},{"name":"TreeBuilder","value":9930}]},{"name":"events","children":[{"name":"DataEvent","value":2313},{"name":"SelectionEvent","value":1880},{"name":"TooltipEvent","value":1701},{"name":"VisualizationEvent","value":1117}]},{"name":"legend","children":[{"name":"Legend","value":20859},{"name":"LegendItem","value":4614},{"name":"LegendRange","value":10530}]},{"name":"operator","children":[{"name":"distortion","children":[{"name":"BifocalDistortion","value":4461},{"name":"Distortion","value":6314},{"name":"FisheyeDistortion","value":3444}]},{"name":"encoder","children":[{"name":"ColorEncoder","value":3179},{"name":"Encoder","value":4060},{"name":"PropertyEncoder","value":4138},{"name":"ShapeEncoder","value":1690},{"name":"SizeEncoder","value":1830}]},{"name":"filter","children":[{"name":"FisheyeTreeFilter","value":5219},{"name":"GraphDistanceFilter","value":3165},{"name":"VisibilityFilter","value":3509}]},{"name":"IOperator","value":1286},{"name":"label","children":[{"name":"Labeler","value":9956},{"name":"RadialLabeler","value":3899},{"name":"StackedAreaLabeler","value":3202}]},{"name":"layout","children":[{"name":"AxisLayout","value":6725},{"name":"BundledEdgeRouter","value":3727},{"name":"CircleLayout","value":9317},{"name":"CirclePackingLayout","value":12003},{"name":"DendrogramLayout","value":4853},{"name":"ForceDirectedLayout","value":8411},{"name":"IcicleTreeLayout","value":4864},{"name":"IndentedTreeLayout","value":3174},{"name":"Layout","value":7881},{"name":"NodeLinkTreeLayout","value":12870},{"name":"PieLayout","value":2728},{"name":"RadialTreeLayout","value":12348},{"name":"RandomLayout","value":870},{"name":"StackedAreaLayout","value":9121},{"name":"TreeMapLayout","value":9191}]},{"name":"Operator","value":2490},{"name":"OperatorList","value":5248},{"name":"OperatorSequence","value":4190},{"name":"OperatorSwitch","value":2581},{"name":"SortOperator","value":2023}]},{"name":"Visualization","value":16540}]}]};

// ------------------------------------------------------------
// Component
// ------------------------------------------------------------
export default function RadialTreeExplorer({ data = sampleData }) {
  // Accept object or JSON string for data
  const parsed = useMemo(() => coerceHierarchyInput(data) || sampleData, [data]);

  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const gRef = useRef(null);

  // Keep the original root data so we can "Reset root"
  const [rootData] = useState(() => safeClone(parsed));
  const [focusPathIdxs, setFocusPathIdxs] = useState([]);
  const focusedData = useMemo(() => getNodeByPathIdxs(rootData, focusPathIdxs) ?? rootData, [rootData, focusPathIdxs]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [dims, setDims] = useState({ width: 900, height: 600 });
  const pendingSelectAbsPathRef = useRef(null);

  // Unified focus helper used by double‑click, button, and breadcrumb
  const focusAtNodeData = (nodeData) => {
    const absPath = [...focusPathIdxs, ...(nodeData?._pathIdxs || [])];
    // Preserve selection of this node across focus change
    pendingSelectAbsPathRef.current = absPath;
    setFocusPathIdxs(absPath);
  };
  const focusAtAbsPath = (absPath = []) => {
    setFocusPathIdxs(absPath);
    setSelectedNode(null);
  };

  // Responsive sizing via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setDims({ width: cr.width, height: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { root, nodes, links, radius } = useMemo(() => {
    const width = Math.max(400, dims.width);
    const height = Math.max(300, dims.height);

    const r = Math.min(width, height) / 2 - 24; // padding

    // Build a d3.hierarchy from the focused (possibly re-rooted) data
    const viewData = limitDepth(focusedData, MAX_DEPTH);
    const h = d3
      .hierarchy(viewData)
      .sort((a, b) => d3.ascending(a.data.name, b.data.name));

    // Layout in polar coords: angle [0, 2π), radius [0, r]
    const tree = d3.tree().size([2 * Math.PI, r]);
    const laidOut = tree(h);

    return {
      root: laidOut,
      nodes: laidOut.descendants(),
      links: laidOut.links(),
      radius: r,
    };
  }, [focusedData, dims.width, dims.height]);

  // After focus change/layout recompute, keep the intended selection visible
  useEffect(() => {
    const absPending = pendingSelectAbsPathRef.current;
    if (!absPending) return;
    const rel = absPending.slice(focusPathIdxs.length);
    const targetRel = rel.slice(0, MAX_DEPTH);
    const eq = (a = [], b = []) => a.length === b.length && a.every((v, i) => v === b[i]);

    let chosen = null;
    if (targetRel.length === 0) {
      chosen = root; // focused node is the selection
    } else {
      chosen = nodes.find((n) => eq(n.data?._pathIdxs || [], targetRel)) || null;
      if (!chosen) {
        // Fallback: deepest visible ancestor along target path
        let best = root;
        for (const n of nodes) {
          const p = n.data?._pathIdxs || [];
          let isPrefix = true;
          for (let i = 0; i < Math.min(p.length, targetRel.length); i++) {
            if (p[i] !== targetRel[i]) { isPrefix = false; break; }
          }
          if (isPrefix && p.length > (best.data?._pathIdxs || []).length) best = n;
        }
        chosen = best;
      }
    }
    setSelectedNode(chosen);
    pendingSelectAbsPathRef.current = null;
  }, [nodes, root, focusPathIdxs]);

  // Initialize zoom/pan and clear transforms when the root changes
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const g = d3.select(gRef.current);

    const zoomed = (event) => {
      g.attr(
        "transform",
        `translate(${dims.width / 2},${dims.height / 2}) ${event.transform}`
      );
    };

    const zoom = d3
      .zoom()
      .scaleExtent([0.4, 4])
      // Ignore double-click so it doesn't trigger zoom; we handle dblclick for focus ourselves
      .filter((event) => event.type !== "dblclick")
      .on("zoom", zoomed);

    svg.call(zoom);

    // Also remove the built-in dblclick zoom handler for extra safety
    svg.on("dblclick.zoom", null);

    // Reset to identity transform when focusedData changes
    svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity);

    return () => svg.on("zoom", null);
  }, [focusedData, dims.width, dims.height]);

  // Helpers to convert polar (angle, radius) to Cartesian
  const radialPoint = (x, y) => [
    Math.cos(x - Math.PI / 2) * y,
    Math.sin(x - Math.PI / 2) * y,
  ];

  const linkPath = d3.linkRadial().angle((d) => d.x).radius((d) => d.y);

  // Single vs double click handling
  const clickTimeout = useRef(null);

  const handleNodeClick = (node) => {
    if (clickTimeout.current) {
      clearTimeout(clickTimeout.current);
      clickTimeout.current = null;
    }
    clickTimeout.current = setTimeout(() => {
      setSelectedNode(node);
    }, 180);
  };

  const handleNodeDoubleClick = (node) => {
    if (clickTimeout.current) {
      clearTimeout(clickTimeout.current);
      clickTimeout.current = null;
    }
    focusAtNodeData(node?.data);
  };

  const resetRoot = () => {
    setFocusPathIdxs([]);
    setSelectedNode(null);
  };

  // Selected absolute path (FULL tree)
  const selectedAbsPath = useMemo(() => {
    if (!selectedNode) return null;
    return [...focusPathIdxs, ...(selectedNode?.data?._pathIdxs || [])];
  }, [selectedNode, focusPathIdxs]);

  // Breadcrumb from FULL tree
  const breadcrumb = useMemo(() => {
    if (!selectedAbsPath) return [];
    const crumbs = [];
    let cur = rootData;
    crumbs.push({ name: cur.name, absPath: [] });
    for (let i = 0; i < selectedAbsPath.length; i++) {
      const idx = selectedAbsPath[i];
      if (!cur || !Array.isArray(cur.children) || !cur.children[idx]) break;
      cur = cur.children[idx];
      crumbs.push({ name: cur.name, absPath: selectedAbsPath.slice(0, i + 1) });
    }
    return crumbs;
  }, [rootData, selectedAbsPath]);

  // 👉 Map the selected (PRUNED) node back to the ORIGINAL full subtree
  const originalSelected = useMemo(() => {
    if (!selectedNode) return null;
    return getOriginalFromPrunedNode(rootData, focusPathIdxs, selectedNode);
  }, [selectedNode, rootData, focusPathIdxs]);

  const originalChildrenCount = originalSelected && Array.isArray(originalSelected.children)
    ? originalSelected.children.length
    : 0;

  const originalTotalValue = useMemo(() => (
    originalSelected ? sumValuesDeep(originalSelected) : null
  ), [originalSelected]);

  const originalLeafCount = useMemo(() => (
    originalSelected ? countLeavesDeep(originalSelected) : 0
  ), [originalSelected]);

  // Domain-specific side panel data (from FULL node)
  const originalRequirements = useMemo(() => asArray(originalSelected?.requirements), [originalSelected]);
  const originalBlocks = useMemo(() => asArray(originalSelected?.relatedSystemBlocks), [originalSelected]);
  const originalMeta = originalSelected?.metadata ?? null;

  const [showAllReqs, setShowAllReqs] = useState(false);
  const maxPreview = 6;

  // Node value access helper (flare leaves often carry `value`)
  const nodeValue = (n) => (n && n.data && typeof n.data.value === "number" ? n.data.value : null);

  // Helpers for small badges
  const Pill = ({ children, className = "" }) => (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${className}`}>{children}</span>
  );

  const Field = ({ label, children }) => (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <div className="text-[11px] text-gray-500 col-span-1">{label}</div>
      <div className="col-span-2 font-medium break-words">{children ?? "—"}</div>
    </div>
  );

  return (
    <div className="w-full h-[80vh] grid grid-cols-12 gap-4 p-4 bg-gray-50">
      {/* Graph area */}
      <div
        ref={containerRef}
        className="col-span-8 relative rounded-2xl border bg-white"
      >
        <svg
          ref={svgRef}
          width={dims.width}
          height={dims.height}
          className="absolute inset-0 w-full h-full"
          role="img"
          aria-label="Radial tree"
        >
          {/* Centering group; zoom behavior applies transform updates here */}
          <g ref={gRef} transform={`translate(${dims.width / 2},${dims.height / 2})`}>
            {/* links */}
            <g fill="none" stroke="#bbb" strokeOpacity={0.7}>
              {links.map((l, i) => (
                <path key={`link-${i}`} d={linkPath(l)} />
              ))}
            </g>

            {/* nodes */}
            <g>
              {nodes.map((n, i) => {
                const [x, y] = radialPoint(n.x, n.y);
                const isSelected = selectedNode && selectedNode.data === n.data;
                const isLeft = n.x >= Math.PI;
                const rx = Math.cos(n.x - Math.PI / 2);
                const ry = Math.sin(n.x - Math.PI / 2);
                const pad = LABEL_RADIAL_PAD_BASE + LABEL_RADIAL_PAD_EXTRA * Math.abs(ry);
                const isEdgeDepth = n.depth === MAX_DEPTH; // rotate edge labels tangentially
                const angleDeg = (n.x * 180) / Math.PI;
                const rotateDeg = (angleDeg - 90);
                const transformStr = isEdgeDepth
                  ? `translate(${rx * pad},${ry * pad}) rotate(${rotateDeg})`
                  : `translate(${rx * pad},${ry * pad})`;
                return (
                  <g
                    key={`node-${i}-${n.data?.name ?? "noname"}`}
                    transform={`translate(${x},${y})`}
                    className="cursor-pointer"
                    onClick={() => handleNodeClick(n)}
                    onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); handleNodeDoubleClick(n); }}
                  >
                    <circle
                      r={n.children ? 4 : 3}
                      fill={isSelected ? "#2563eb" : n.children ? "#111827" : "#6b7280"}
                    />
                    <text
                      dy="0.35em"
                      x={isEdgeDepth ? 6 : (isLeft ? -4 : 4)}
                      textAnchor={isEdgeDepth ? "start" : (isLeft ? "end" : "start")} dominantBaseline="middle"
                      transform={transformStr}
                      fontSize={12}
                      className="select-none"
                      fill={isSelected ? "#1d4ed8" : "#111827"}
                    >
                      {n.data.name}{n.data._hasHidden ? " …" : ""}
                    </text>
                  </g>
                );
              })}
            </g>
          </g>
        </svg>

        {/* overlay controls */}
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <button
            onClick={resetRoot}
            className="rounded-xl border px-3 py-1 text-sm bg-white hover:bg-gray-50 shadow-sm"
            title="Reset to original root"
          >
            Reset root
          </button>
        </div>

        <div className="absolute right-3 bottom-3 text-xs text-gray-500 bg-white/70 rounded-md px-2 py-1">
          Scroll = zoom • Drag = pan • Double‑click = re‑root
        </div>
      </div>

      {/* Side panel */}
      <div className="col-span-4 h-full overflow-auto rounded-2xl border bg-white">
        <div className="p-4 space-y-4">
          <h2 className="text-lg font-semibold">Node Details</h2>

          {!selectedNode && (
            <p className="text-gray-600 text-sm">Single‑click a node to see its details here.</p>
          )}

          {selectedNode && (
            <div className="space-y-4">
              {/* Basic */}
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500">Name</div>
                <div className="text-base font-medium break-words">{selectedNode.data.name}</div>
                {originalSelected?.id && (
                  <div className="mt-1 text-xs text-gray-500">ID: {originalSelected.id}</div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="rounded-xl border p-2">
                  <div className="text-[11px] text-gray-500">Depth (visible)</div>
                  <div className="font-medium">{selectedNode.depth}</div>
                </div>
                <div className="rounded-xl border p-2">
                  <div className="text-[11px] text-gray-500">Children (original)</div>
                  <div className="font-medium">{originalChildrenCount}</div>
                </div>
                <div className="rounded-xl border p-2">
                  <div className="text-[11px] text-gray-500">Value (aggregate)</div>
                  <div className="font-medium">{originalTotalValue ?? "—"}</div>
                </div>
              </div>

              {/* Breadcrumb (FULL tree) */}
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Path</div>
                <div className="flex flex-wrap items-center gap-1 text-sm">
                  {breadcrumb.map((c, i) => {
                    const isLast = i === breadcrumb.length - 1;
                    return (
                      <React.Fragment key={`crumb-${i}`}>
                        <button
                          type="button"
                          onClick={() => focusAtAbsPath(c.absPath)}
                          className={isLast ? "px-1 rounded font-medium text-gray-900 cursor-default" : "px-1 rounded text-gray-600 hover:text-gray-900 hover:underline"}
                          title={isLast ? "Current node" : "Focus at this ancestor"}
                        >
                          {c.name}
                        </button>
                        {i !== breadcrumb.length - 1 && <span className="text-gray-400">›</span>}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Metadata */}
              <div className="pt-2 border-t">
                <h3 className="text-sm font-semibold mb-2">Metadata</h3>
                <div className="space-y-1">
                  <Field label="Owner">{originalMeta?.owner}</Field>
                  <Field label="Version">{originalMeta?.version}</Field>
                  <Field label="Last Updated">{originalMeta?.lastUpdated}</Field>
                </div>
              </div>

              {/* Requirements */}
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">Requirements</h3>
                  <Pill>{originalRequirements.length} total</Pill>
                </div>
                {originalRequirements.length === 0 ? (
                  <div className="text-xs text-gray-500">No requirements linked to this node.</div>
                ) : (
                  <ul className="space-y-2">
                    {originalRequirements
                      .slice(0, showAllReqs ? originalRequirements.length : maxPreview)
                      .map((r) => (
                        <li key={r.reqId} className="rounded-xl border p-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-medium text-sm break-words">{r.title}</div>
                            <div className="flex items-center gap-1">
                              {r.priority && <Pill className="text-gray-700">{r.priority}</Pill>}
                              {r.status && <Pill className="text-gray-700">{r.status}</Pill>}
                            </div>
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">{r.reqId}{r.source ? ` • ${r.source}` : ""}</div>
                          {r.text && <div className="text-xs text-gray-800 mt-1 whitespace-pre-wrap">{r.text}</div>}
                          {(r.verification?.method || r.verification?.status) && (
                            <div className="text-[11px] text-gray-600 mt-1">Verification: {r.verification?.method ?? "—"} / {r.verification?.status ?? "—"}</div>
                          )}
                          {r.acceptanceCriteria && (
                            <details className="mt-1">
                              <summary className="text-xs text-gray-700 cursor-pointer">Acceptance criteria</summary>
                              <div className="text-xs text-gray-800 mt-1 whitespace-pre-wrap">{r.acceptanceCriteria}</div>
                            </details>
                          )}
                        </li>
                      ))}
                  </ul>
                )}
                {originalRequirements.length > maxPreview && (
                  <div className="mt-2">
                    <button
                      onClick={() => setShowAllReqs((v) => !v)}
                      className="rounded-lg border px-2 py-1 text-xs bg-white hover:bg-gray-50"
                    >
                      {showAllReqs ? "Collapse" : `Show all (${originalRequirements.length - maxPreview} more)`}
                    </button>
                  </div>
                )}
              </div>

              {/* Related System Blocks */}
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">Related System Blocks</h3>
                  <Pill>{originalBlocks.length} total</Pill>
                </div>
                {originalBlocks.length === 0 ? (
                  <div className="text-xs text-gray-500">No blocks linked to this node.</div>
                ) : (
                  <ul className="space-y-2">
                    {originalBlocks.map((b) => (
                      <li key={b.blockId || b.name} className="rounded-xl border p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-sm break-words">{b.name}</div>
                          <div className="flex items-center gap-1">
                            {b.type && <Pill className="text-gray-700">{b.type}</Pill>}
                            {b.layer && <Pill className="text-gray-700">{b.layer}</Pill>}
                          </div>
                        </div>
                        <div className="text-[11px] text-gray-500 mt-0.5">{b.blockId ?? ""}</div>
                        <div className="text-[11px] text-gray-600 mt-1">
                          Interfaces: {asArray(b.interfaceRefs).length > 0 ? asArray(b.interfaceRefs).join(", ") : "None"}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Focus & stats footer */}
              <div className="pt-2 flex flex-wrap gap-2 items-center">
                <button
                  onClick={() => focusAtNodeData(selectedNode?.data)}
                  className="rounded-xl border px-3 py-1 text-sm bg-white hover:bg-gray-50 shadow-sm"
                >
                  Focus at this node
                </button>
                {originalSelected && (
                  <div className="text-xs text-gray-500">
                    Leaves (original): {originalLeafCount}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="pt-4 border-t">
            <h3 className="text-sm font-semibold mb-1">Layout</h3>
            <div className="text-xs text-gray-600">
              Radius: {Math.round(radius)} px • Nodes: {nodes.length} • Links: {links.length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Lightweight runtime tests (opt‑in)
// Set `window.__RUN_RT_TESTS__ = true` before loading this module (e.g., in index.html)
// or call RadialTreeExplorer.__runTests() from the console to execute on demand.
// ------------------------------------------------------------
const validateHierarchy = (obj) => {
  if (!obj || typeof obj !== "object") throw new Error("Data must be an object or JSON string representing an object.");
  if (!("name" in obj)) throw new Error("Root object must have a 'name' property.");
  if ("children" in obj && !Array.isArray(obj.children)) throw new Error("'children' must be an array when provided.");
  return true;
};

const runRuntimeTests = () => {
  const results = [];
  try {
    // 1) Object form of sampleData
    results.push({ name: "object sampleData parses", pass: validateHierarchy(sampleData) === true });

    // 2) JSON string form of sampleData
    const jsonStr = JSON.stringify(sampleData);
    const parsed = coerceHierarchyInput(jsonStr);
    results.push({ name: "JSON string parses", pass: validateHierarchy(parsed) === true });

    // 3) Invalid data should fail
    let failed = false;
    try { validateHierarchy({ bogus: true }); } catch { failed = true; }
    results.push({ name: "invalid data rejected (missing name)", pass: failed === true });

    // 4) limitDepth preserves path mapping back to original
    const pruned = limitDepth(sampleData, 2);
    const prunedNodeSim = { data: getNodeByPathIdxs(pruned, [0, 0]) }; // analytics/cluster
    const origFromPruned = getOriginalFromPrunedNode(sampleData, [], prunedNodeSim);
    const expectedOrig = getNodeByPathIdxs(sampleData, [0, 0]);
    results.push({ name: "pruned→original mapping (cluster)", pass: origFromPruned && expectedOrig && origFromPruned.name === expectedOrig.name });

    // 5) sumValuesDeep matches known total for analytics/cluster
    const sumCluster = sumValuesDeep(expectedOrig);
    results.push({ name: "sumValuesDeep(cluster) == 15207", pass: sumCluster === 15207, got: sumCluster });

    // 6) countLeavesDeep for analytics/cluster
    const leavesCluster = countLeavesDeep(expectedOrig);
    results.push({ name: "countLeavesDeep(cluster) == 4", pass: leavesCluster === 4, got: leavesCluster });

    // 7) clipRelPathToDepth sanity
    const rel1 = clipRelPathToDepth([0], [0, 1, 2, 3], 2); // expect [1,2]
    const okClip = Array.isArray(rel1) && rel1.length === 2 && rel1[0] === 1 && rel1[1] === 2;
    results.push({ name: "clipRelPathToDepth trims to window", pass: okClip, got: rel1 });

    // 8) requirements/blocks extraction on synthetic node
    const tNode = { name: "n", requirements: [{ reqId: "R1" }, { reqId: "R2" }], relatedSystemBlocks: [{ blockId: "B1" }] };
    const tReqs = asArray(tNode.requirements); const tBlks = asArray(tNode.relatedSystemBlocks);
    results.push({ name: "requirements length == 2", pass: tReqs.length === 2, got: tReqs.length });
    results.push({ name: "blocks length == 1", pass: tBlks.length === 1, got: tBlks.length });

    console.table(results);
    return results;
  } catch (e) {
    console.error("Runtime tests encountered an error:", e);
    return [{ name: "tests crashed", pass: false, error: String(e) }];
  }
};

// Expose a hook for on-demand tests without polluting global scope excessively
RadialTreeExplorer.__runTests = runRuntimeTests;

if (typeof window !== "undefined" && window.__RUN_RT_TESTS__ === true) {
  // Delay slightly to avoid blocking initial render in some environments
  setTimeout(runRuntimeTests, 0);
}
