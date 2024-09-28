d3.csv("data/batting_limits_1871-2024.csv").then((points) => {
    console.log("parse ...");

    const parsedPoints = []
    points.forEach((point) => {
        parsedPoints.push({
            playerID: point["playerID"],
            yearID: parseInt(point["yearID"]),
            teamID: point["teamID"],
            teamID: point["teamID"],
            lgID: point["lgID"],
            G: parseInt(point["G"]),
            G_batting: parseInt(point["G_batting"]),
            AB: parseInt(point["AB"]),
            R: parseInt(point["R"]),
            H: parseInt(point["H"]),
            "2B": parseInt(point["2B"]),
            "3B": parseInt(point["3B"]),
            HR: parseInt(point["HR"]),
            RBI: parseInt(point["RBI"]),
            SB: parseInt(point["SB"]),
            CS: parseInt(point["CS"]),
            BB: parseInt(point["BB"]),
            SO: parseInt(point["SO"]),
            IBB: parseInt(point["IBB"]),
            HBP: parseInt(point["HBP"]),
            SH: parseInt(point["SH"]),
            SF: parseInt(point["SF"]),
            GIDP: parseInt(point["GIDP"])
        })
    });

    console.log(parsedPoints);
    console.log("parse OK");

    return parsedPoints;
})
.then((points) => {
    console.log("main ...");
    console.log(points);

    const dimensions = ["G","AB","R","H","2B","3B","HR","RBI","SB","CS","BB","SO","IBB","HBP","SH","SF","GIDP"]
    populateSelectors(points, dimensions); 

    function refreshChart() {
        console.log("RefreshChart ...");
        const xDim = d3.select("#x-axis-select").property("value");
        const yDim = d3.select("#y-axis-select").property("value");
        const sYear = d3.select("#s-year-select").property("value");
        const eYear = d3.select("#e-year-select").property("value");
        const loadingIndicator = document.getElementById("loading-indicator");
        loadingIndicator.style.display = "flex";
        drawScatterPlot(points, xDim, yDim, sYear, eYear);
        loadingIndicator.style.display = "none";
        console.log("RefreshChart OK");
    }

    refreshChart();

    d3.select("#x-axis-select").on("change", function () {
        console.log("x-axis-select change ...");
        refreshChart();
        console.log("x-axis-select change OK");
    });

    d3.select("#y-axis-select").on("change", function () {
        console.log("y-axis-select change ...");
        refreshChart();
        console.log("y-axis-select change OK");
    });

    d3.select("#s-year-select").on("change", function () {
        console.log("s-year-select change ...");
        refreshChart();
        console.log("s-year-select change OK");
    });

    d3.select("#e-year-select").on("change", function () {
        console.log("e-year-select change ...");
        refreshChart();
        console.log("e-year-select change OK");
    });
});

function populateSelectors(points, dimensions) {
    console.log("populateSelectors ...");
    console.log(points);

    const years = [...new Set(points.map(point => point.yearID))].sort((a, b) => a - b);

    const sYearSelect = document.getElementById("s-year-select");

    sYearSelect.innerHTML = '';
    
    years.forEach(year => {
        const option = document.createElement("option");
        option.value = year;
        option.text = year;
        sYearSelect.appendChild(option);
    });

    // beginning of live ball era
    sYearSelect.value = Math.max(1920, years[0]);

    const eYearSelect = document.getElementById("e-year-select");

    eYearSelect.innerHTML = '';

    years.forEach(year => {
        const option = document.createElement("option");
        option.value = year;
        option.text = year;
        eYearSelect.appendChild(option);
    });

    eYearSelect.value =  years[years.length - 1];

    const xAxisSelect = document.getElementById("x-axis-select");

    xAxisSelect.innerHTML = '';

    dimensions.forEach(dim => {
        const option = document.createElement("option");
        option.value = dim;
        option.text = dim.toUpperCase();
        xAxisSelect.appendChild(option);
    });

    xAxisSelect.value = "HR";

    const yAxisSelect = document.getElementById("y-axis-select");

    yAxisSelect.innerHTML = '';

    dimensions.forEach(dimmension => {
        const option = document.createElement("option");
        option.value = dimmension;
        option.text = dimmension.toUpperCase();
        yAxisSelect.appendChild(option);
    });

    yAxisSelect.value = "SB";

    console.log("populateSelectors OK");
}

function drawScatterPlot(points, xDim, yDim, sYear, eYear) {
    console.log("drawScatterPlot ...")
    console.log(`xDim=${xDim} yDim=${yDim}, sYear=${sYear}, eYear=${eYear}`)

    console.log("scatter-plot ...");
    const svg = d3.select("#scatter-plot");
    console.log("scatter-plot OK");

    console.log("remove ...");
    svg.selectAll("*").remove(); // Clear existing plot
    console.log("remove OK")

    const dataPoints = [];

    console.log("copy ...");
    points.forEach((point) => {
        dataPoints.push({
            x: point[xDim],
            y: point[yDim],
            year: point.yearID,
            details: `${point.playerID} ${point[xDim]}/${point[yDim]} (${point.teamID} ${point.lgID} ${point.yearID})`
        })
    });
    console.log(dataPoints);
    console.log("copy OK");

    console.log("filter ...");
    const allPoints = dataPoints
        .filter((point) => {
            return !isNaN(point.x)
                && !isNaN(point.y)
                && !isNaN(point.year)
                && point.year >= sYear
                && point.year <= eYear;
        })
        .sort((lhs, rhs) => {
            if (lhs.x != rhs.x) {
                return lhs.x - rhs.x;
            }

            if (lhs.y != rhs.y) {
                return lhs.y - rhs.y;
            }

            // prefer recent points
            return rhs.year - lhs.year
        });

    console.log(`allPoint.length ${allPoints.length}`);
    console.log(allPoints);

    const uniquePoints = 
        allPoints.slice(0, 1)
                 .concat(allPoints
                    .slice(1)
                    .filter((point, index) => {
                        return (point.x !== allPoints[index].x || point.y !== allPoints[index].y);
                    }));

    console.log(`uniquePoints.length ${uniquePoints.length}`);
    console.log(uniquePoints);

    console.log("filter OK");

    console.log("special ...");
    const specialPoints = []
    uniquePoints.forEach(point => {
        while (specialPoints.length > 0 && specialPoints[specialPoints.length - 1].y < point.y) {
            specialPoints.pop();
        }
        if (specialPoints.length > 0 && specialPoints[specialPoints.length - 1].y == point.y && specialPoints[specialPoints.length - 1].x < point.x) {
            specialPoints.pop();
        }
        specialPoints.push(point);
    });

    console.log(specialPoints)
    console.log("special OK");

    const svgElement = document.getElementById('scatter-plot');
    const svgElementRect = svgElement.getBoundingClientRect();
    const svgElementWidth = svgElementRect.width;
    const svgElementHeight = svgElementRect.height;

    console.log(`svgElementWidth: ${svgElementWidth}`);
    console.log(`svgElementHeight: ${svgElementHeight}`);

    const xScale = d3.scaleLinear()
        .domain(d3.extent(uniquePoints, d => d.x))
        .nice()
        .range([50, svgElementWidth - 50]);
    
    console.log(`xScale.domain(): ${xScale.domain()}`);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(uniquePoints, d => d.y))
        .nice()
        .range([svgElementHeight, 50]);

    console.log(`yScale.domain(): ${yScale.domain()}`);

    svg.selectAll("circle")
        .data(uniquePoints)
        .enter()
        .append("circle")
        .attr("class", d => specialPoints.includes(d) ? "special-point" : "regular-point")
        .attr("cx", d => xScale(d.x))
        .attr("cy", d => yScale(d.y))
        .attr("r", 8)
        .on("mouseover", function(event, d) {
            d3.select(this).attr("r", 16);
            const tooltip = d3.select("#tooltip");

            const MaxPointsOnSameCoordinates = 5;

            // TODO: make it faster ?
            const tooltipContent = allPoints
                .filter(point => point.x === d.x && point.y === d.y)
                .filter((_, index) => index < MaxPointsOnSameCoordinates)
                .map((point) => point.details)
                .join("<br>");
            
            tooltip.style("opacity", 1)
                .html(tooltipContent)
                .style("left", (event.pageX + 5) + "px")
                .style("top", (event.pageY - 28) + "px");
        })
        .on("mouseout", function(event, d) {
            d3.select(this).attr("r", 8);
            d3.select("#tooltip").style("opacity", 0);
        });

    svg.selectAll("line")
        .data(specialPoints.slice(1))
        .enter()
        .append("line")
        .attr("x1", (d, i) => xScale(specialPoints[i].x))
        .attr("y1", (d, i) => yScale(specialPoints[i].y))
        .attr("x2", (d) => xScale(d.x))
        .attr("y2", (d) => yScale(d.y))
        .attr("stroke", "#003f87")
        .attr("stroke-width", 2);
    
    svg.append("g")
        .attr("transform", "translate(0," + svgElementHeight + ")")
        .call(d3.axisBottom(xScale));
    
    svg.append("g")
        .attr("transform", "translate(50,0)")
        .call(d3.axisLeft(yScale));
    
    console.log("drawScatterPlot OK")
}
