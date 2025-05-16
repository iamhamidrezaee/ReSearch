// paperMap.js
class MultiClusterMap {
    constructor(containerId, tooltipId) {
        this.containerId = containerId;
        this.tooltipId = tooltipId;

        // Grab DOM elements
        this.container = document.getElementById(containerId);
        this.tooltip = document.getElementById(tooltipId);

        // Distances for cluster logic
        this.centerThreshold = 120;   // near cluster's center => become new center
        this.detachThreshold = 650;   // far => new cluster

        // Tooltip timing
        this.tooltipDelay = 1000;
        this.hoverTimer = null;

        // Array of clusters, each with its own simulation + group
        this.clusters = [];
        // Give each cluster a numeric ID
        this.clusterCounter = 0;
        this.activeClusterId = null;

        // Zoom configuration
        this.zoomExtent = [0.2, 5]; // Min and max zoom levels
        this.currentZoom = 1;       // Track zoom level

        // Reinforcement mode state
        this.reinforcementMode = false;
        this.selectedReinforceNodes = new Set();
        this.maxReinforceSelections = 3;
        this.currentCenterPaperId = null;
        this.setupReinforcementListeners();

        this.favorites = JSON.parse(localStorage.getItem('paperFavorites')) || {};
        this.setupFavoritesContainer();



        // If you have a loading or "message" state, we can display that
        this.showMessage("Search for research papers to visualize")
    }

    // ---------------------------------------
    // Reinforcement Mode Setup
    // ---------------------------------------

    // Add this new method to handle reinforcement keyboard events
    setupReinforcementListeners() {
        document.addEventListener('keydown', (event) => {
            if (event.key.toLowerCase() === 'shift' && !this.reinforcementMode) {
                this.enterReinforcementMode();
            }
        });

        document.addEventListener('keyup', (event) => {
            if (event.key.toLowerCase() === 'shift' && this.reinforcementMode) {
                this.exitReinforcementMode();
            }
        });
    }

    // New method to enter reinforcement mode
    enterReinforcementMode() {
        const targetId = this.activeClusterId ?? this.clusters[0]?.id;
        const targetClus = this.getCluster(targetId);
        if (!targetClus) return;
        this.activeClusterId = targetId;
        d3.select('.reinforce-hint').remove();
        this.reinforcementMode = true;
        this.selectedReinforceNodes.clear();
        const centreNode = targetClus.nodes.find(n => n.id === 0);
        this.currentCenterPaperId = centreNode?.original_id ?? null;
        let overlaySel = d3.select('.reinforcement-overlay');
        let messageSel;
        if (overlaySel.empty()) {
            overlaySel = d3.select(`#${this.containerId}`)
                .append('div')
                .attr('class', 'reinforcement-overlay');

            messageSel = overlaySel.append('div')
                .attr('class', 'reinforcement-message')
                .style('position', 'absolute')
                .style('top', '20px')
                .style('left', '50%')
                .style('transform', 'translateX(-50%)');
        }
        else {
            messageSel = overlaySel.select('.reinforcement-message');
        }
        messageSel.html('Select <b>1 – 3</b> papers you want to reinforce');
    }

    // New method to exit reinforcement mode
    exitReinforcementMode() {
        if (!this.reinforcementMode) return;

        this.reinforcementMode = false;

        // Remove overlay
        d3.select(".reinforcement-overlay").remove();

        if (this.selectedReinforceNodes.size === 0) {
            this.showReinforceHint();
        }

        if (this.selectedReinforceNodes.size > 0) {
            this.applyReinforcement();
        }

        // Clear all selections visually
        d3.selectAll(".paper-node-group")
            .classed("selected", false)
            .select("circle")
            .attr("stroke", "#333")
            .attr("stroke-width", 1.5)
            .style("filter", d => d.id === 0 ? "drop-shadow(0 4px 6px rgba(0, 0, 0, 0.3))" : "drop-shadow(0 4px 6px rgba(0, 0, 0, 0.3))");
    }

    async applyReinforcement() {
        if (this.selectedReinforceNodes.size === 0) return;

        try {
            const selectedIds = Array.from(this.selectedReinforceNodes).map(n => n.original_id);
            const centerPaperId = this.currentCenterPaperId;

            const resp = await fetch("/reinforce", {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    center_id: centerPaperId,
                    selected_ids: selectedIds
                })
            });

            if (!resp.ok) throw new Error(`Network error: ${resp.statusText}`);

            const data = await resp.json();

            const mainCluster = this.getCluster(this.activeClusterId);
            if (!mainCluster) return;
            await new Promise(res => {
                mainCluster.nodeGroup
                    .selectAll('.paper-node-group')
                    .filter(d => d.id !== 0 && !this.selectedReinforceNodes.has(d))
                    .transition().duration(600)
                    .style('opacity', 0)
                    .on('end', (_, i, nodes) => {
                        if (i === nodes.length - 1) res();
                    });

                mainCluster.linkGroup
                    .selectAll('.paper-link')
                    .filter(l =>
                        !this.selectedReinforceNodes.has(l.source) &&
                        !this.selectedReinforceNodes.has(l.target)
                    )
                    .transition().duration(600)
                    .style('opacity', 0);
            });

            this.showLoading();

            if (!data.center) {
                throw new Error("Invalid response from server");
            }

            // Clear existing clusters
            this.clusters.forEach(cluster => {
                if (cluster.group) cluster.group.remove();
            });
            this.clusters = [];

            // Create new cluster with reinforced data
            this.container.innerHTML = "";

            const containerRect = document.createElement("div");
            containerRect.className = "map-container-rect";
            this.container.appendChild(containerRect);

            const svgRect = containerRect.getBoundingClientRect();
            this.width = svgRect.width;
            this.height = svgRect.height;

            this.svg = d3.select(containerRect)
                .append("svg")
                .attr("width", "100%")
                .attr("height", "100%")
                .attr("viewBox", `0 0 ${this.width} ${this.height}`)
                .attr("preserveAspectRatio", "xMidYMid meet");

            this.zoomGroup = this.svg.append("g")
                .attr("class", "zoom-group");

            this.initZoom();
            this.createCluster(data, { x: this.width / 2, y: this.height / 2 });

            const keepStroke = d3.selectAll('.paper-node-group')
                .filter(d => selectedIds.includes(d.original_id))
                .select('circle')
                .attr('stroke', '#ffcc00')
                .attr('stroke-width', 3)
                .style('filter', 'drop-shadow(0 0 6px rgba(255,204,0,0.6))');

            keepStroke
                .transition()
                .delay(3000)
                .duration(800)
                .attr('stroke-width', 1.5)
                .attr('stroke', '#333')
                .style('filter', null);


            this.showReinforceHint(4000);

        } catch (err) {
            console.error("Reinforcement error:", err);
            this.showMessage(`Error: ${err.message}`);
        }
    }

    handleNodeClick(event, d) {
        if (this.reinforcementMode) {
            this.activeClusterId = d.__clusterId;
            const centre = this.getCluster(this.activeClusterId)
                ?.nodes.find(n => n.id === 0);
            this.currentCenterPaperId = centre?.original_id ?? null;
            if (d.id === 0) return; // Don't allow selecting the center node

            event.stopPropagation();

            if (this.selectedReinforceNodes.has(d)) {
                // Deselect
                this.selectedReinforceNodes.delete(d);
                d3.select(event.currentTarget.parentNode)
                    .classed("selected", false)
                    .select("circle")
                    .transition()
                    .duration(300)
                    .attr("stroke", "#aaa")
                    .attr("stroke-width", 2)
                    .attr("stroke-dasharray", "5,5")
                    .style("filter", "drop-shadow(0 4px 6px rgba(0, 0, 0, 0.3))");
            } else if (this.selectedReinforceNodes.size < this.maxReinforceSelections) {
                // Select
                this.selectedReinforceNodes.add(d);
                d3.select(event.currentTarget.parentNode)
                    .classed("selected", true)
                    .select("circle")
                    .transition()
                    .duration(300)
                    .attr("stroke", "#ffcc00")
                    .attr("stroke-width", 3)
                    .attr("stroke-dasharray", null)
                    .style("filter", "drop-shadow(0 0 8px rgba(255, 204, 0, 0.6))");
            }

            // Update the reinforcement message
            d3.select(".reinforcement-message")
                .html(`Reinforcement Mode: Click up to ${this.maxReinforceSelections} papers to reinforce`);

        } else {
            // Original behavior - open paper link
            this.activeClusterId = d.__clusterId;
            this.openPaperLink(d);
        }
    }


    //--------------------------------------
    //  LOADING & STATUS MESSAGES
    //--------------------------------------
    showMessage(msg) {
        this.container.innerHTML = `<div class="map-message">${msg}</div>`;
    }

    showLoading() {
        this.container.innerHTML = '<div class="loading-map">Working on it...</div>';
    }

    showDragHint() {
        const hint = d3.select(`#${this.containerId}`)
            .append("div")
            .attr("class", "hint-message")
            .html('Tip: Drag a node near its center to become new center, or far away to spawn another cluster. Use mouse wheel to zoom in/out.');

        setTimeout(() => {
            hint.transition().duration(1000).style("opacity", 0).remove();
        }, 5000);
    }

    showReinforceHint() {
        // only show once
        if (document.querySelector('.reinforce-hint')) return;

        const kwBar = document.getElementById('keyword-search-container');
        if (!kwBar) return;

        // ensure it's a positioning parent
        kwBar.style.position = 'relative';

        // append the hint _inside_ the keyword bar
        d3.select(kwBar)
            .append('div')
            .attr('class', 'reinforce-hint')
            .html('Press&nbsp;<b>Shift</b>&nbsp;to activate reinforcement');
    }


    //--------------------------------------
    //  KEYWORD HIGHLIGHT FUNCTIONALITY
    //--------------------------------------
    keywordHighlightMap(searchInput) {
        // Store reference to this class instance
        const self = this;

        // Parse input to get keywords
        const raw = searchInput.toLowerCase().trim();
        const keywords = raw.split(/[\s,]+/).filter(k => k);

        // First, reset all nodes to their original state
        d3.selectAll(".paper-node-group").each(function (d) {
            const node = d3.select(this);

            // Reset the fill color to the color determined by the class method
            node.select("circle").attr("fill", d.originalColor || self.getNodeColor(d));

            // Remove any highlight rings
            node.select(".highlight-ring").remove();

            // Reset stroke to default
            node.select("circle")
                .attr("stroke", "#333")
                .attr("stroke-width", 1.5);
        });

        if (keywords.length === 0) return;
        // Apply a subtle highlight to matching nodes
        d3.selectAll(".paper-node-group").each(function (d) {
            const node = d3.select(this);
            const paper = d;

            const abstract = (paper.abstract || "").toLowerCase();
            const title = (paper.title || "").toLowerCase();
            const hasAll = keywords.every(k => abstract.includes(k) || title.includes(k));

            if (hasAll) {
                // Apply a more elegant highlight effect
                node.select("circle")
                    .attr("stroke", "#ffcc00")
                    .attr("stroke-width", 3)
                    .style("filter", "drop-shadow(0 0 5px rgba(255, 204, 0, 0.5))");

                // Add an animated highlight ring
                const currentRadius = parseFloat(node.select("circle").attr("r"));
                node.append("circle")
                    .attr("class", "highlight-ring")
                    .attr("cx", 0)
                    .attr("cy", 0)
                    .attr("r", currentRadius + 5)
                    .attr("fill", "none")
                    .attr("stroke", "#ffcc00")
                    .attr("stroke-width", 2)
                    .attr("stroke-opacity", 0.7);
            }
        });
    }

    //--------------------------------------
    //  MAIN SEARCH -> BUILD FIRST CLUSTER
    //--------------------------------------
    async fetchData(query) {
        if (!query || !query.trim()) {
            this.showMessage("Search for research papers to visualize");
            return;
        }
        this.showLoading();

        try {
            const resp = await fetch("/map_data?" + new URLSearchParams({ query }).toString());
            if (!resp.ok) throw new Error(`Network error: ${resp.statusText}`);

            const data = await resp.json();
            if (!data.center) {
                this.showMessage("No results found");
                return;
            }

            // Clear old clusters
            this.clusters = [];
            // Clear the container
            this.container.innerHTML = "";

            // Create a <div> to hold the <svg>
            const containerRect = document.createElement("div");
            containerRect.className = "map-container-rect";
            this.container.appendChild(containerRect);

            // Determine size
            this.width = this.container.clientWidth;
            this.height = this.container.clientHeight;

            // Create main SVG
            this.svg = d3.select(containerRect)
                .append("svg")
                .attr("width", "100%")
                .attr("height", "100%")
                .attr("viewBox", `0 0 ${this.width} ${this.height}`)
                .attr("preserveAspectRatio", "xMidYMid meet");

            // Add a group for all clusters that will be transformed during zoom
            this.zoomGroup = this.svg.append("g")
                .attr("class", "zoom-group");

            // Initialize zoom behavior
            this.initZoom();

            // Show a helpful drag hint
            this.showDragHint();

            // Create the initial cluster in center
            this.createCluster(data, { x: this.width / 2, y: this.height / 2 });
            document.getElementById("keyword-search-container").style.display = "flex";
            this.showReinforceHint();
        } catch (err) {
            console.error("fetchData error:", err);
            this.showMessage(`Error: ${err.message}`);
        }
    }

    //--------------------------------------
    //  INITIALIZE ZOOM BEHAVIOR
    //--------------------------------------
    initZoom() {
        // Create zoom behavior
        this.zoom = d3.zoom()
            .scaleExtent(this.zoomExtent)
            .on("zoom", (event) => {
                // Store current zoom level
                this.currentZoom = event.transform.k;

                // Apply transformation to the zoom group
                this.zoomGroup.attr("transform", event.transform);

                // Update tooltip position calculation for zoomed view
                this.updateTooltipPositionForZoom();
            });

        // Apply zoom to SVG
        this.svg.call(this.zoom);

        // Add zoom controls
        this.addZoomControls();
    }

    addZoomControls() {
        // Create zoom controls div - using the CSS class from the stylesheet
        const controlsDiv = d3.select(`#${this.containerId}`)
            .append("div")
            .attr("class", "zoom-controls");

        // Zoom in button
        controlsDiv.append("button")
            .attr("class", "zoom-button")
            .html("+")
            .on("click", () => this.zoomBy(1.2)); // Zoom in by 20%

        // Zoom out button
        controlsDiv.append("button")
            .attr("class", "zoom-button")
            .html("−")
            .on("click", () => this.zoomBy(0.8)); // Zoom out by 20%

        // Reset zoom button
        controlsDiv.append("button")
            .attr("class", "zoom-button")
            .html("⟲")
            .on("click", () => this.resetZoom());
    }

    zoomBy(factor) {
        // Calculate new zoom level, constrained by zoom extent
        const newScale = Math.max(
            this.zoomExtent[0],
            Math.min(this.zoomExtent[1], this.currentZoom * factor)
        );

        // Use D3's zoom.transform to zoom to the new level
        this.svg.transition()
            .duration(300)
            .call(
                this.zoom.transform,
                d3.zoomIdentity.scale(newScale)
            );
    }

    resetZoom() {
        // Reset to original scale and position
        this.svg.transition()
            .duration(500)
            .call(
                this.zoom.transform,
                d3.zoomIdentity
            );
    }

    //--------------------------------------
    //  CREATE A NEW CLUSTER
    //--------------------------------------
    createCluster(mapData, position) {
        // position => (x,y) where cluster will roughly gather
        const cid = ++this.clusterCounter;

        // Build the data arrays for nodes & links
        // Make local copies so we can store a special property __clusterId
        const centerNode = { ...mapData.center, __clusterId: cid, id: 0 };  // center => id=0
        const relatedNodes = mapData.related.map((r, i) => ({
            ...r, __clusterId: cid, id: i + 1
        }));
        const nodes = [centerNode, ...relatedNodes];
        const links = relatedNodes.map(n => ({
            source: 0,    // center is node id=0
            target: n.id, // the related node
            value: n.score
        }));

        // Create a group for this entire cluster
        // Append to zoomGroup instead of directly to SVG
        const clusterGroup = this.zoomGroup.append("g")
            .attr("class", `cluster-group c${cid}`);

        clusterGroup
            .style('opacity', 0)
            .transition().duration(600)
            .style('opacity', 1);


        // Make subgroups for links & nodes
        const linkGroup = clusterGroup.append("g").attr("class", "links-container");
        const nodeGroup = clusterGroup.append("g").attr("class", "nodes-container");

        // Link selection
        const linkSel = linkGroup.selectAll("line")
            .data(links)
            .enter()
            .append("line")
            .attr("class", "paper-link")
            .attr("stroke", "#444")
            .attr("stroke-opacity", 0.6)
            .attr("stroke-width", d => Math.max(1, d.value * 6));

        // Node selection
        const nodeSel = nodeGroup.selectAll("g.paper-node-group")
            .data(nodes)
            .enter()
            .append("g")
            .attr("class", "paper-node-group")
            .call(d3.drag()
                .on("start", (event, d) => this.dragstarted(event, d, cid))
                .on("drag", (event, d) => this.dragged(event, d, cid))
                .on("end", (event, d) => this.dragended(event, d, cid))
            );

        // Circles
        nodeSel.append("circle")
            .attr("class", "paper-node")
            .attr("r", 0)
            .attr("fill", d => {
                const color = this.getNodeColor(d);
                d.originalColor = color;
                return color;
            })
            .attr("stroke", "#333")
            .attr("stroke-width", 1.5)
            // Delayed tooltip
            .on("mouseover", (event, d) => this.handleNodeMouseOver(event, d))
            .on("mouseout", () => this.handleNodeMouseOut())
            .on("click", (event, d) => this.handleNodeClick(event, d));

        // Titles
        this.addNodeTitles(nodeSel);

        nodeSel.style('opacity', 0)
            .transition()
            .delay((d, i) => i * 20)
            .duration(500)
            .style('opacity', 1);

        nodeSel.select('circle')
            .transition()
            .delay((d, i) => i * 25)
            .duration(500)
            .attr('r', d => this.getNodeRadius(d));

        linkSel.attr('stroke-opacity', 0)
            .transition()
            .delay((d, i) => i * 20)
            .duration(500)
            .attr('stroke-opacity', 0.6);

        // Force simulation local to this cluster
        const simulation = d3.forceSimulation(nodes)
            // weaker link pull, min distance 50px
            .force("link", d3.forceLink(links)
                .id(d => d.id)
                .distance(d => 150 * (1 - d.value) + 150)
                .strength(0.2)
            )
            // gentler repulsion
            .force("charge", d3.forceManyBody().strength(-200))
            // lighter, fixed collision padding
            .force("collision", d3.forceCollide()
                .radius(d => this.getNodeRadius(d) + 30)
            )
            // softer centering gravity
            .force("x", d3.forceX(position.x).strength(0.05))
            .force("y", d3.forceY(position.y).strength(0.05));

        simulation.on("tick", () => {
            // Apply inter-cluster node collision force before updating positions
            if (this.clusters.length > 0) {
                this.applyInterClusterNodeCollision();
            }

            linkSel
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);

            nodeSel
                .attr("transform", d => `translate(${d.x},${d.y})`);

            // Update cluster bounds after each tick
            this.updateClusterBounds(cid);

            // Apply inter-cluster separation force
            if (this.clusters.length > 1) {
                this.applyClusterSeparationForce();
            }
        });

        // Save cluster info
        this.clusters.push({
            id: cid,
            group: clusterGroup,
            linkGroup,
            nodeGroup,
            nodes,
            links,
            simulation,
            position: position, // Store initial position
            bounds: {           // Will be updated during simulation
                minX: position.x - 200,
                maxX: position.x + 200,
                minY: position.y - 200,
                maxY: position.y + 200,
                centerX: position.x,
                centerY: position.y,
                radius: 200     // Initial estimated radius
            }
        });

        // Initial bounds calculation
        this.updateClusterBounds(cid);

        // Re-establish the inter-cluster forces now that we have a new cluster
        this.setupGlobalForces();
        if (document.getElementById('keyword-search-bar').value.trim()) {
            this.keywordHighlightMap(document.getElementById('keyword-search-bar').value);
        }
        this.activeClusterId = cid;
        return this.clusters[this.clusters.length - 1];

    }

    //--------------------------------------
    //  GLOBAL FORCES FOR ALL CLUSTERS
    //--------------------------------------
    setupGlobalForces() {
        // This method establishes forces that work across all clusters
        // Call this when clusters are added or removed

        // We don't need to do anything if we only have 0 or 1 cluster
        if (this.clusters.length <= 1) return;

        // Restart all simulations to apply new forces
        this.clusters.forEach(cluster => {
            if (cluster.simulation) {
                cluster.simulation.alpha(0.3).restart();
            }
        });
    }

    //--------------------------------------
    //  INTER-CLUSTER NODE COLLISION
    //--------------------------------------
    applyInterClusterNodeCollision() {
        // Stop if we only have one cluster
        if (this.clusters.length <= 1) return;

        // Extra padding for nodes from different clusters
        // (should be larger than intra-cluster collision padding)
        const INTER_CLUSTER_PADDING = 10;

        // Quadratic complexity, but for small numbers of clusters it's acceptable
        for (let i = 0; i < this.clusters.length; i++) {
            const clusterA = this.clusters[i];

            for (let j = i + 1; j < this.clusters.length; j++) {
                const clusterB = this.clusters[j];

                // Check each pair of nodes between the two clusters
                for (let nodeA of clusterA.nodes) {
                    for (let nodeB of clusterB.nodes) {
                        // Skip if either node is being dragged (has fixed position)
                        if (nodeA.fx !== null || nodeA.fy !== null ||
                            nodeB.fx !== null || nodeB.fy !== null) continue;

                        // Distance between the nodes
                        const dx = nodeB.x - nodeA.x;
                        const dy = nodeB.y - nodeA.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);

                        // Minimum distance required (sum of radii + extra padding)
                        const radiusA = this.getNodeRadius(nodeA);
                        const radiusB = this.getNodeRadius(nodeB);
                        const minDistance = radiusA + radiusB + INTER_CLUSTER_PADDING;

                        // If nodes are too close
                        if (distance < minDistance && distance > 0) {
                            // Calculate repulsion force
                            const force = (minDistance - distance) / distance;

                            // Unit vector for force direction
                            const unitX = dx / distance;
                            const unitY = dy / distance;

                            // Apply stronger forces for inter-cluster collisions
                            // Move both nodes apart proportional to force
                            nodeA.x -= unitX * force * 2; // Doubled strength
                            nodeA.y -= unitY * force * 2;
                            nodeB.x += unitX * force * 2;
                            nodeB.y += unitY * force * 2;

                            // Add velocity to help maintain separation
                            // This makes the nodes "bounce" away from each other
                            if (nodeA.vx !== undefined && nodeA.vy !== undefined) {
                                nodeA.vx -= unitX * force * 0.5;
                                nodeA.vy -= unitY * force * 0.5;
                            }

                            if (nodeB.vx !== undefined && nodeB.vy !== undefined) {
                                nodeB.vx += unitX * force * 0.5;
                                nodeB.vy += unitY * force * 0.5;
                            }
                        }
                    }
                }
            }
        }
    }

    //--------------------------------------
    //  CLUSTER SEPARATION LOGIC
    //--------------------------------------
    updateClusterBounds(clusterId) {
        const cluster = this.getCluster(clusterId);
        if (!cluster || !cluster.nodes.length) return;

        // Find min/max coordinates of all nodes in this cluster
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        cluster.nodes.forEach(node => {
            if (!node.x || !node.y) return; // Skip nodes without positions

            const radius = this.getNodeRadius(node);
            minX = Math.min(minX, node.x - radius);
            minY = Math.min(minY, node.y - radius);
            maxX = Math.max(maxX, node.x + radius);
            maxY = Math.max(maxY, node.y + radius);
        });

        // Update bounds if we have valid values
        if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
            cluster.bounds = {
                minX, minY, maxX, maxY,
                // Calculate center point and radius
                centerX: (minX + maxX) / 2,
                centerY: (minY + maxY) / 2,
                radius: Math.max(maxX - minX, maxY - minY) / 2 + 50 // Add padding
            };
        }
    }

    applyClusterSeparationForce() {
        // Enhanced cluster-level separation with more aggressive parameters
        const MIN_SEPARATION = 100; // Increased from 50 to 100

        // Loop through all cluster pairs
        for (let i = 0; i < this.clusters.length; i++) {
            const clusterA = this.clusters[i];

            for (let j = i + 1; j < this.clusters.length; j++) {
                const clusterB = this.clusters[j];

                // Calculate distance between cluster centers
                const dx = clusterB.bounds.centerX - clusterA.bounds.centerX;
                const dy = clusterB.bounds.centerY - clusterA.bounds.centerY;
                const distance = Math.sqrt(dx * dx + dy * dy);

                // Minimum required distance (increased padding)
                const minDistance = clusterA.bounds.radius + clusterB.bounds.radius + MIN_SEPARATION;

                // If clusters are too close
                if (distance < minDistance && distance > 0) {
                    // Unit vector of the direction to push
                    const unitX = dx / distance;
                    const unitY = dy / distance;

                    // Force strength (stronger when closer)
                    const strength = (minDistance - distance) / minDistance * 0.2; // Doubled from 0.1

                    // Apply force to all nodes in both clusters
                    clusterA.nodes.forEach(node => {
                        if (node.fx === null) { // Only apply force to non-fixed nodes
                            node.vx -= unitX * strength * 15; // Increased from 10
                            node.vy -= unitY * strength * 15;
                        }
                    });

                    clusterB.nodes.forEach(node => {
                        if (node.fx === null) { // Only apply force to non-fixed nodes
                            node.vx += unitX * strength * 15;
                            node.vy += unitY * strength * 15;
                        }
                    });

                    // Also apply a direct position adjustment for faster response
                    if (!this.isClusterBeingDragged(clusterA) && !this.isClusterBeingDragged(clusterB)) {
                        const moveAmount = (minDistance - distance) / 2 * 1.5; // 50% stronger movement

                        this.moveCluster(clusterA, -unitX * moveAmount, -unitY * moveAmount);
                        this.moveCluster(clusterB, unitX * moveAmount, unitY * moveAmount);
                    }
                }
            }
        }
    }

    isClusterBeingDragged(cluster) {
        // Return true if any node in the cluster has fx, fy not null (indicating it's being dragged)
        return cluster.nodes.some(node => node.fx !== null || node.fy !== null);
    }

    moveCluster(cluster, dx, dy) {
        // Move all nodes in a cluster by dx, dy
        cluster.nodes.forEach(node => {
            node.x += dx;
            node.y += dy;
        });

        // Update visual position immediately
        cluster.nodeGroup.selectAll(".paper-node-group")
            .attr("transform", d => `translate(${d.x},${d.y})`);

        // Update link positions
        cluster.linkGroup.selectAll(".paper-link")
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        // Update bounds
        this.updateClusterBounds(cluster.id);
    }

    //--------------------------------------
    //  DRAG LOGIC
    //--------------------------------------
    dragstarted(event, d, clusterId) {
        // Prevent zoom during drag
        if (event.sourceEvent) event.sourceEvent.stopPropagation();

        const cluster = this.getCluster(clusterId);
        if (!event.active) cluster.simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    dragged(event, d, clusterId) {
        d.fx = event.x;
        d.fy = event.y;
    }

    async dragended(event, d, clusterId) {
        const cluster = this.getCluster(clusterId);
        d.fx = null;
        d.fy = null;
        cluster.simulation.alpha(0.3).restart();

        // If center node => ignore
        if (d.id === 0) return;

        // Distance from cluster center
        const centerNode = cluster.nodes.find(n => n.id === 0);
        if (!centerNode) return;
        const dist = Math.hypot(d.x - centerNode.x, d.y - centerNode.y);

        if (dist < this.centerThreshold) {
            // => become new center
            this.animateNodeToCenter(d, cluster);
        } else if (dist > this.detachThreshold) {
            // => new cluster
            this.detachNode(d, cluster);
        }
    }

    getCluster(cid) {
        return this.clusters.find(c => c.id === cid);
    }

    //--------------------------------------
    //  MAKE A NODE THE NEW CENTER - WITH SEAMLESS TRANSITION
    //--------------------------------------
    animateNodeToCenter(nodeDatum, cluster) {
        // 1. Get exact positions for a seamless transition
        const exactNodePos = { x: nodeDatum.x, y: nodeDatum.y };

        // 2. Stop simulation during transition for stability
        cluster.simulation.stop();

        // 3. Save the node's visual elements to preserve them during transition
        const chosenNodeSel = cluster.nodeGroup
            .selectAll(".paper-node-group")
            .filter(d => d === nodeDatum);

        // 4. Create a transition holder div to maintain the node position during data fetch
        const transitionNodeGroup = this.zoomGroup.append("g")
            .attr("class", "transition-node-group")
            .attr("transform", `translate(${exactNodePos.x},${exactNodePos.y})`);

        // 5. Clone the visual appearance of the chosen node
        const transitionCircle = transitionNodeGroup.append("circle")
            .attr("class", "paper-node")
            .attr("r", this.getNodeRadius(nodeDatum))
            .attr("fill", this.getNodeColor(nodeDatum))
            .attr("stroke", "#333")
            .attr("stroke-width", 1.5);

        const transitionText = transitionNodeGroup.append("text")
            .attr("class", "paper-title")
            .attr("text-anchor", "middle")
            .attr("dy", ".35em")
            .style("font-size", "11px")
            .style("fill", "#f0f0f0")
            .text(this.truncateTitle(nodeDatum.title, 25));

        // 6. Fade out all existing nodes and links EXCEPT the chosen node
        cluster.nodeGroup.selectAll(".paper-node-group")
            .filter(d => d !== nodeDatum)
            .transition()
            .duration(400)
            .style("opacity", 0)
            .remove();

        cluster.linkGroup.selectAll(".paper-link")
            .transition()
            .duration(400)
            .style("opacity", 0)
            .remove();

        // 7. Expand the transition node
        transitionCircle.transition()
            .duration(600)
            .attr("r", 70)
            .attr("fill", "#ff3333");

        transitionText.transition()
            .duration(600)
            .style("font-size", "14px")
            .style("font-weight", "bold")
            .style("fill", "#fff");

        // 8. Fade out the original node once we have the transition copy
        chosenNodeSel.transition()
            .duration(300)
            .style("opacity", 0)
            .remove();

        // 9. Completely remove the old cluster (but keep our transition node)
        setTimeout(() => {
            if (cluster.group) {
                cluster.group.remove();
            }
            this.clusters = this.clusters.filter(c => c !== cluster);

            // 10. Fetch data and create new cluster exactly where the transition node is
            const fetchAndCreateNewCluster = async () => {
                const origId = nodeDatum.original_id;
                if (origId !== undefined) {
                    const newData = await this.fetchPaperAsQuery(origId);
                    if (newData && newData.center) {
                        // 11. Create the new cluster precisely at the transition node position
                        this.createInPlaceCluster(newData, exactNodePos, transitionNodeGroup);
                    }
                }
            };

            fetchAndCreateNewCluster();
        }, 500); // Short delay to ensure smooth transition
    }

    //--------------------------------------
    //  CREATE IN-PLACE CLUSTER - ENSURES PERFECT POSITIONING
    //--------------------------------------
    createInPlaceCluster(mapData, position, transitionNode) {
        // Create a new cluster to replace the transition node
        const cid = ++this.clusterCounter;

        // Use the center data from our fetch but keep the position exact
        const centerNode = { ...mapData.center, __clusterId: cid, id: 0, x: position.x, y: position.y, fx: position.x, fy: position.y };
        const relatedNodes = mapData.related.map((r, i) => ({
            ...r, __clusterId: cid, id: i + 1,
            // Start all related nodes at the center position for animation outward
            x: position.x, y: position.y
        }));

        const nodes = [centerNode, ...relatedNodes];
        const links = relatedNodes.map(n => ({
            source: 0,
            target: n.id,
            value: n.score
        }));

        // Create the cluster group
        const clusterGroup = this.zoomGroup.append("g")
            .attr("class", `cluster-group c${cid}`);

        const linkGroup = clusterGroup.append("g").attr("class", "links-container");
        const nodeGroup = clusterGroup.append("g").attr("class", "nodes-container");

        // Create links with starting point at center
        const linkSel = linkGroup.selectAll("line")
            .data(links)
            .enter()
            .append("line")
            .attr("class", "paper-link")
            .attr("stroke", "#444")
            .attr("stroke-opacity", 0) // Start invisible
            .attr("stroke-width", d => Math.max(1, d.value * 6))
            .attr("x1", position.x)
            .attr("y1", position.y)
            .attr("x2", position.x)
            .attr("y2", position.y);

        // Create nodes at center position initially
        const nodeSel = nodeGroup.selectAll("g.paper-node-group")
            .data(nodes)
            .enter()
            .append("g")
            .attr("class", "paper-node-group")
            .attr("transform", d => `translate(${position.x},${position.y})`)
            .style("opacity", d => d.id === 0 ? 1 : 0) // Only center visible initially
            .call(d3.drag()
                .on("start", (event, d) => this.dragstarted(event, d, cid))
                .on("drag", (event, d) => this.dragged(event, d, cid))
                .on("end", (event, d) => this.dragended(event, d, cid))
            );

        // Create the circles for each node
        nodeSel.append("circle")
            .attr("class", "paper-node")
            .attr("r", d => this.getNodeRadius(d))
            .attr("fill", d => this.getNodeColor(d))
            .attr("stroke", "#333")
            .attr("stroke-width", 1.5)
            .on("mouseover", (event, d) => this.handleNodeMouseOver(event, d))
            .on("mouseout", () => this.handleNodeMouseOut())
            .on("click", (event, d) => this.handleNodeClick(event, d));

        // Add text titles
        this.addNodeTitles(nodeSel);

        // Hide the center node initially (we'll reveal it when transition node is removed)
        nodeSel.filter(d => d.id === 0).style("opacity", 0);

        // Create the force simulation (gentle start)
        const simulation = d3.forceSimulation(nodes)
            // weaker link pull, min distance 50px
            .force("link", d3.forceLink(links)
                .id(d => d.id)
                .distance(d => 150 * (1 - d.value) + 150)
                .strength(0.2)
            )
            // gentler repulsion
            .force("charge", d3.forceManyBody().strength(-200))
            // lighter, fixed collision padding
            .force("collision", d3.forceCollide()
                .radius(d => this.getNodeRadius(d) + 30)
            )
            // softer centering gravity
            .force("x", d3.forceX(position.x).strength(0.05))
            .force("y", d3.forceY(position.y).strength(0.05))
            .alpha(0); // Start paused

        // Keep center node fixed initially
        centerNode.fx = position.x;
        centerNode.fy = position.y;

        simulation.on("tick", () => {
            // Apply inter-cluster node collision force
            if (this.clusters.length > 0) {
                this.applyInterClusterNodeCollision();
            }

            linkSel
                .attr("x1", d => d.source.x)
                .attr("y1", d => d.source.y)
                .attr("x2", d => d.target.x)
                .attr("y2", d => d.target.y);

            nodeSel
                .attr("transform", d => `translate(${d.x},${d.y})`);

            this.updateClusterBounds(cid);

            if (this.clusters.length > 1) {
                this.applyClusterSeparationForce();
            }
        });

        // Save to clusters array
        this.clusters.push({
            id: cid,
            group: clusterGroup,
            linkGroup,
            nodeGroup,
            nodes,
            links,
            simulation,
            position,
            bounds: {
                minX: position.x - 200,
                maxX: position.x + 200,
                minY: position.y - 200,
                maxY: position.y + 200,
                centerX: position.x,
                centerY: position.y,
                radius: 200
            }
        });


        // Start the seamless transition
        // 1. First remove transition node while revealing center node
        setTimeout(() => {
            // Fade out transition node
            transitionNode.transition()
                .duration(300)
                .style("opacity", 0)
                .remove();

            // Fade in our real center node
            nodeSel.filter(d => d.id === 0)
                .transition()
                .duration(300)
                .style("opacity", 1);

            // 2. After center node is visible, begin radiating links and nodes outward
            setTimeout(() => {
                // Release the center node's fixed position gradually
                setTimeout(() => {
                    centerNode.fx = null;
                    centerNode.fy = null;
                }, 1000);

                // Fade in links with staggered timing
                linkSel.transition()
                    .delay((d, i) => i * 25)
                    .duration(500)
                    .attr("stroke-opacity", 0.6);

                // Fade in nodes with staggered timing
                nodeSel.filter(d => d.id !== 0)
                    .transition()
                    .delay((d, i) => i * 30)
                    .duration(600)
                    .style("opacity", 1);

                // Gently start simulation
                simulation.alpha(0.3).restart();

                // Gradually increase simulation intensity
                setTimeout(() => {
                    simulation.alpha(0.8).restart();
                }, 500);
            }, 300);
        }, 300);

        this.activeClusterId = cid;
        this.updateClusterBounds(cid);
        return this.clusters[this.clusters.length - 1];
    }

    //--------------------------------------
    //  DETACH => NEW CLUSTER WITH SEAMLESS ANIMATION
    //--------------------------------------
    detachNode(nodeDatum, cluster) {
        // 1. Capture exact position for seamless transition
        const exactNodePos = { x: nodeDatum.x, y: nodeDatum.y };

        // 2. Create a transition node to maintain visual continuity during data fetch
        const transitionNodeGroup = this.zoomGroup.append("g")
            .attr("class", "transition-node-group")
            .attr("transform", `translate(${exactNodePos.x},${exactNodePos.y})`);

        // Clone the visual appearance of the detached node
        const transitionCircle = transitionNodeGroup.append("circle")
            .attr("class", "paper-node")
            .attr("r", this.getNodeRadius(nodeDatum))
            .attr("fill", this.getNodeColor(nodeDatum))
            .attr("stroke", "#333")
            .attr("stroke-width", 1.5);

        const transitionText = transitionNodeGroup.append("text")
            .attr("class", "paper-title")
            .attr("text-anchor", "middle")
            .attr("dy", ".35em")
            .style("font-size", "11px")
            .style("fill", "#f0f0f0")
            .text(this.truncateTitle(nodeDatum.title, 25));

        // 3. Highlight the transition node briefly to show it's being detached
        transitionCircle.transition()
            .duration(300)
            .attr("r", this.getNodeRadius(nodeDatum) * 1.2)
            .attr("stroke", "#ff3333")
            .attr("stroke-width", 3);

        // 4. Find and animate out the connections from the original cluster
        const connectedLinks = cluster.linkGroup
            .selectAll(".paper-link")
            .filter(l => l.source === nodeDatum || l.target === nodeDatum);

        // Fade out connected links with transition
        connectedLinks
            .transition()
            .duration(400)
            .style("opacity", 0)
            .remove();

        // 5. Fade out the original node from the cluster
        const nodeSel = cluster.nodeGroup
            .selectAll(".paper-node-group")
            .filter(d => d === nodeDatum);

        nodeSel.transition()
            .duration(400)
            .style("opacity", 0)
            .remove();

        // 6. Update the data structures in the original cluster
        cluster.links = cluster.links.filter(l =>
            l.source !== nodeDatum && l.target !== nodeDatum
        );
        cluster.nodes = cluster.nodes.filter(n => n !== nodeDatum);

        // 7. Restart the original cluster's simulation
        cluster.simulation.alpha(0.3).restart();

        // 8. If no original_id, we can't fetch new data
        if (nodeDatum.original_id === undefined) {
            // Just clean up the transition node in this case
            setTimeout(() => {
                transitionNodeGroup.transition()
                    .duration(400)
                    .style("opacity", 0)
                    .remove();
            }, 800);
            return;
        }

        // 9. Fetch data for the new cluster while maintaining the transition node
        setTimeout(async () => {
            try {
                const data = await this.fetchPaperAsQuery(nodeDatum.original_id);
                if (!data || !data.center) {
                    // If we couldn't get data, fade out the transition node
                    transitionNodeGroup.transition()
                        .duration(400)
                        .style("opacity", 0)
                        .remove();
                    return;
                }

                // 10. Create the new cluster in place with a smooth animation
                this.createInPlaceCluster(data, exactNodePos, transitionNodeGroup);

            } catch (err) {
                console.error("Error fetching data for detached node:", err);
                // Clean up the transition node on error
                transitionNodeGroup.transition()
                    .duration(400)
                    .style("opacity", 0)
                    .remove();
            }
        }, 500); // Short delay for visual effect and to ensure links are removed
    }

    //--------------------------------------
    //  FETCH PAPER AS QUERY (no entire re-render)
    //--------------------------------------
    async fetchPaperAsQuery(originalId) {
        try {
            const resp = await fetch("/paper_as_query?" + new URLSearchParams({ paper_id: originalId }).toString());
            if (!resp.ok) throw new Error(`Network response not ok: ${resp.statusText}`);
            const data = await resp.json();
            if (!data.center) return null;
            return data;
        } catch (err) {
            console.error("fetchPaperAsQuery error:", err);
            return null;
        }
    }

    //--------------------------------------
    //  NODES: RADIUS, COLOR, TITLE, etc.
    //--------------------------------------
    getNodeRadius(d) {
        // Center node remains unchanged
        if (d.id === 0) return 100;

        // Base size (slightly smaller than current default)
        const baseSize = 15;

        // Similarity score still matters, but with less impact
        const scoreContribution = d.score * 15;

        // Citation count contribution (logarithmic scale for visual balance)
        let citationContribution = 0;
        if (d.citations && d.citations > 0) {
            // Log base 10 with some scaling to make differences visible but not extreme
            // ln(citations + 1) * 5 gives a nice curve:
            // 10 citations = ~12px addition
            // 100 citations = ~23px addition
            // 1000 citations = ~35px addition
            // 10000 citations = ~46px addition
            citationContribution = Math.log(d.citations + 1) * 8;

            // Cap the maximum citation contribution to prevent huge nodes
            citationContribution = Math.min(citationContribution, 45);
        }

        return baseSize + scoreContribution + citationContribution;
    }

    getNodeColor(d) {
        // Center node remains bright red
        if (d.id === 0) return "#ff3333";

        // Create distinct color bands for the high similarity scores
        // Extremely high similarity (0.97-1.0)
        if (d.score >= 0.97) return "#ff6666";  // Brightest red

        // Very high similarity (0.94-0.97)
        if (d.score >= 0.94) return "#ff4444";  // Very bright red

        // High similarity (0.92-0.94)
        if (d.score >= 0.92) return "#ee3333";  // Bright red

        // Moderately high similarity (0.90-0.92)
        if (d.score >= 0.90) return "#cc2222";  // Medium red

        // Medium similarity (0.87-0.90)
        if (d.score >= 0.87) return "#aa1111";  // Medium-dark red

        // Lower similarity (0.85-0.87)
        if (d.score >= 0.85) return "#880000";  // Dark red

        // Low similarity (below 0.85)
        return "#880000";  // Green for clear distinction
    }

    addNodeTitles(selection) {
        selection.append("text")
            .attr("class", "paper-title")
            .attr("text-anchor", "middle")
            .attr("dy", ".35em")
            .style("font-size", d => d.id === 0 ? "14px" : "11px")
            .style("fill", d => d.id === 0 ? "#fff" : "#f0f0f0")
            .style("font-weight", d => d.id === 0 ? "bold" : "normal")
            .text(d => this.truncateTitle(d.title, 25));
    }

    truncateTitle(title, maxLen) {
        if (!title) return "";
        return title.length > maxLen ? title.slice(0, maxLen) + "..." : title;
    }

    //--------------------------------------
    //  TOOLTIP (DELAY)
    //--------------------------------------
    handleNodeMouseOver(event, d) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => {
            const pageX = event.pageX, pageY = event.pageY;
            const tipW = 300;
            let leftPos = pageX + 15;
            if (leftPos + tipW > window.innerWidth) {
                leftPos = pageX - tipW - 15;
            }
            this.tooltip.style.left = leftPos + "px";
            this.tooltip.style.top = (pageY - 100) + "px";

            // Fill contents
            this.tooltip.querySelector(".tooltip-title").textContent = d.title;
            this.tooltip.querySelector(".tooltip-abstract").textContent = d.abstract || "No abstract available";

            // Show
            this.tooltip.style.display = "block";

            // Store the current node for reference
            this.tooltip.dataset.currentNode = d.id;

            // Add mouseenter event to the tooltip
            this.tooltip.addEventListener('mouseenter', this.handleTooltipMouseEnter.bind(this));
            this.tooltip.addEventListener('mouseleave', this.handleTooltipMouseLeave.bind(this));
        }, this.tooltipDelay);
    }

    handleNodeMouseOut() {
        clearTimeout(this.hoverTimer);

        // Don't hide immediately, give time to potentially enter the tooltip
        this.hoverTimer = setTimeout(() => {
            // Only hide if mouse is not over tooltip
            if (!this.isMouseOverTooltip) {
                this.tooltip.style.display = "none";
            }
        }, 100);
    }

    // Add these new methods
    handleTooltipMouseEnter() {
        this.isMouseOverTooltip = true;
        clearTimeout(this.hoverTimer);
    }

    handleTooltipMouseLeave() {
        this.isMouseOverTooltip = false;
        this.tooltip.style.display = "none";

        // Remove the event listeners to prevent memory leaks
        this.tooltip.removeEventListener('mouseenter', this.handleTooltipMouseEnter);
        this.tooltip.removeEventListener('mouseleave', this.handleTooltipMouseLeave);
    }

    //------------------ 
    // POPUP 
    //-------------------
    openPaperLink(d) {
        // Instead of opening a new window, open the PDF in a popup:
        this.createPaperPopup(d.link, d.title, d);
    }

    createPaperPopup(pdfUrl, paperTitle, paperData) {
        // 1. Create a semi-transparent overlay
        const overlay = document.createElement('div');
        overlay.className = 'paper-popup-container';

        // 2. Create the popup content wrapper
        const popupContent = document.createElement('div');
        popupContent.className = 'paper-popup-content';

        // 3. Header with close button
        const header = document.createElement('div');
        header.className = 'paper-popup-header';

        const titleEl = document.createElement('h3');
        titleEl.className = 'paper-popup-title';
        titleEl.textContent = paperTitle || "Paper PDF";

        const closeBtn = document.createElement('button');
        closeBtn.className = 'paper-popup-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            document.body.removeChild(overlay);
        };

        header.appendChild(titleEl);
        header.appendChild(closeBtn);

        // 4. Body with the PDF in an iframe
        const body = document.createElement('div');
        body.className = 'paper-popup-body';

        const iframe = document.createElement('iframe');
        iframe.className = 'paper-popup-iframe';
        iframe.src = pdfUrl; // Link to your PDF (arXiv link, etc.)

        body.appendChild(iframe);

        // 5. Footer with favorite button and external link
        const footer = document.createElement('div');
        footer.className = 'paper-popup-footer';

        // Favorite button
        const favoriteButton = document.createElement('button');
        favoriteButton.className = 'favorite-button';
        favoriteButton.setAttribute('data-paper-id', paperData.original_id);

        // Check if this paper is already a favorite
        const isFavorited = !!this.favorites[paperData.original_id];
        if (isFavorited) {
            favoriteButton.classList.add('favorited');
            favoriteButton.innerHTML = '<i class="fas fa-heart"></i> Favorited';
        } else {
            favoriteButton.innerHTML = '<i class="far fa-heart"></i> Favorite';
        }

        favoriteButton.onclick = () => {
            this.toggleFavorite(paperData);
        };

        const externalLink = document.createElement('a');
        externalLink.className = 'paper-popup-external-link';
        externalLink.href = pdfUrl;
        externalLink.target = '_blank';
        externalLink.textContent = 'Open in new tab';

        const favoriteWrapper = document.createElement('div');
        favoriteWrapper.className = 'paper-popup-favorite';
        favoriteWrapper.appendChild(favoriteButton);

        footer.appendChild(favoriteWrapper);
        footer.appendChild(externalLink);

        // 6. Put it all together
        popupContent.appendChild(header);
        popupContent.appendChild(body);
        popupContent.appendChild(footer);
        overlay.appendChild(popupContent);

        // 7. Add overlay to document
        document.body.appendChild(overlay);
    }

    //--------------------------------------
    //  FAVORITES FUNCTIONALITY
    //--------------------------------------
    setupFavoritesContainer() {
        // Create favorites toggle button
        const toggleBtn = document.createElement('button');
        toggleBtn.onclick = () => this.toggleFavoritesContainer();
        document.body.appendChild(toggleBtn);

        // Setup event listeners for favorites container
        const container = document.getElementById('favorites-container');
        if (container) {
            // Close button
            const closeBtn = container.querySelector('.favorites-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    container.classList.add('hidden');
                });
            }
        }

        // Initial render of favorites
        this.renderFavorites();
    }

    toggleFavoritesContainer() {
        const container = document.getElementById('favorites-container');
        if (container) {
            container.classList.toggle('hidden');
        }
    }

    toggleFavorite(paper) {
        const paperId = paper.original_id;

        if (this.favorites[paperId]) {
            // Remove from favorites
            delete this.favorites[paperId];
        } else {
            // Add to favorites with the correct fields from the paper object
            this.favorites[paperId] = {
                id: paperId,
                title: paper.title || "Unknown Title",
                link: paper.link || "#",
                abstract: paper.abstract || "",
                citations: paper.citations || 0, // This appears to be citation_count in the original data
                timestamp: Date.now()
            };
        }

        // Save to localStorage
        localStorage.setItem('paperFavorites', JSON.stringify(this.favorites));

        // Update the UI
        this.renderFavorites();
        this.updateFavoriteButton(paper);
    }

    updateFavoriteButton(paper) {
        const paperId = paper.original_id;
        const isFavorited = !!this.favorites[paperId];

        // Find the favorite button for this paper
        const favoriteBtn = document.querySelector(`.favorite-button[data-paper-id="${paperId}"]`);
        if (favoriteBtn) {
            if (isFavorited) {
                favoriteBtn.classList.add('favorited');
                favoriteBtn.innerHTML = '<i class="fas fa-heart"></i> Favorited';
            } else {
                favoriteBtn.classList.remove('favorited');
                favoriteBtn.innerHTML = '<i class="far fa-heart"></i> Favorite';
            }
        }
    }

    renderFavorites() {
        const favoritesListEl = document.getElementById('favorites-list');
        if (!favoritesListEl) return;

        // Clear existing content
        favoritesListEl.innerHTML = '';

        // Get favorites as array and sort by recently added
        const favoritesArray = Object.values(this.favorites);
        favoritesArray.sort((a, b) => b.timestamp - a.timestamp);

        if (favoritesArray.length === 0) {
            favoritesListEl.innerHTML = '<div class="no-favorites-message">No favorites yet. Click the heart icon in paper popups to add them.</div>';
            return;
        }

        // Add each favorite to the list
        favoritesArray.forEach(paper => {
            const favoriteItem = document.createElement('div');
            favoriteItem.className = 'favorite-item';

            favoriteItem.innerHTML = `
            <div class="favorite-item-title">${paper.title}</div>
            <div class="favorite-item-meta">
            </div>
            <div class="favorite-item-meta">
                <div>Citations: ${paper.citations || 0}</div>
            </div>
            <div class="favorite-item-actions">
                <a href="${paper.link}" target="_blank" class="favorite-item-link">Open paper in external tab</a>
                <button class="favorite-item-remove" data-paper-id="${paper.id}">Remove</button>
            </div>
        `;

            favoritesListEl.appendChild(favoriteItem);

            // Add event listener to remove button
            const removeBtn = favoriteItem.querySelector('.favorite-item-remove');
            if (removeBtn) {
                removeBtn.addEventListener('click', () => {
                    delete this.favorites[paper.id];
                    localStorage.setItem('paperFavorites', JSON.stringify(this.favorites));
                    this.renderFavorites();
                });
            }
        });
    }

}

//--------------------------------------
//  INIT ON DOMContentLoaded
//--------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    // Instantiate
    const multiMap = new MultiClusterMap('map-container', 'paper-tooltip');

    // Basic input handling
    const searchInput = document.getElementById('map-search-input');

    function debounce(fn, wait) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    const debouncedSearch = debounce(() => {
        const query = searchInput.value.trim();
        if (query) multiMap.fetchData(query);
    }, 500);

    searchInput.addEventListener('input', debouncedSearch);
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) multiMap.fetchData(query);
        }
    });

    // If you have an onclick to focus
    window.sendFocus = function () {
        searchInput.focus();
    };

    // Optionally auto-focus
    searchInput.focus();
});
