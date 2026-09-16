/*
 * Copyright (C) 2026 jpetrina
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
 * OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/*
 * Unbound Overview dashboard widget (proof of concept).
 *
 * Mirrors the essentials of /ui/unbound/overview in a dashboard cell using
 * only the existing API endpoints (top passed + top blocked domains side by
 * side, like the page):
 *   GET /api/unbound/overview/is_enabled
 *   GET /api/unbound/overview/totals/<max>
 *   GET /api/unbound/overview/rolling/<period>
 *   GET /api/unbound/overview/get_policies
 */

export default class UnboundOverview extends BaseWidget {
    constructor(config) {
        super(config);
        this.period = '12';      // hours
        this.topN = 10;
        this.enabled = true;
        this.chart = null;
        this.policies = {};
        this.lastTotals = null;
        this.tickTimeout = 60;
    }

    _eid(name) {
        return `unboundov-${this.id}-${name}`;
    }

    getMarkup() {
        let $container = $(`
            <div class="unbound-overview-widget" style="padding: 5px;">
                <div id="${this._eid('disabled')}" class="alert alert-warning hide">
                    Query logging is disabled. Enable statistics under
                    Services &rarr; Unbound DNS &rarr; Settings to see data here.
                </div>
                <div id="${this._eid('content')}">
                    <div style="display: flex; gap: 5px; margin-bottom: 8px;">
                        <select id="${this._eid('period')}" class="form-control" title="Time period">
                            <option value="1">Last 1 hour</option>
                            <option value="12" selected>Last 12 hours</option>
                            <option value="24">Last 24 hours</option>
                        </select>
                    </div>
                    <div id="${this._eid('stats')}" style="display: flex; gap: 15px;"></div>
                    <div style="height: 200px; margin-top: 8px;">
                        <canvas id="${this._eid('chart')}"></canvas>
                    </div>
                    <div style="display: flex; gap: 10px; margin-top: 8px;">
                        <ul id="${this._eid('top')}" class="list-group" style="flex: 1;"></ul>
                        <ul id="${this._eid('top-blocked')}" class="list-group" style="flex: 1;"></ul>
                    </div>
                </div>
            </div>
        `);

        return $container;
    }

    async onMarkupRendered() {
        $(document).on(`change.unboundov-${this.id}`, `#${this._eid('period')}`, (e) => {
            this.period = e.target.value;
            if (this.enabled) {
                this._update().catch(() => {});
            }
        });

        const data = await this.ajaxCall('/api/unbound/overview/is_enabled');
        this._setEnabled(data && data.enabled != 0);

        if (!this.enabled) {
            return;
        }

        try {
            this.policies = await this.ajaxCall('/api/unbound/overview/get_policies') || {};
        } catch (e) {
            /* policies are only used for blocked-domain labels; not fatal */
        }

        if (!this.chart && typeof Chart !== 'undefined') {
            this._createChart();
        }

        await this._update();
    }

    async onWidgetTick() {
        const data = await this.ajaxCall('/api/unbound/overview/is_enabled');
        const enabled = !!(data && data.enabled != 0);

        if (this.enabled !== enabled) {
            this._setEnabled(enabled);
            if (!enabled) {
                return;
            }

            if (!this.chart && typeof Chart !== 'undefined') {
                this._createChart();
            }
        }

        await this._update();
    }

    onWidgetClose() {
        $(document).off(`change.unboundov-${this.id}`);
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }

    _setEnabled(enabled) {
        this.enabled = enabled;
        $(`#${this._eid('disabled')}`).toggleClass('hide', enabled);
        $(`#${this._eid('content')}`).toggleClass('hide', !enabled);
    }

    _createChart() {
        const canvas = document.getElementById(this._eid('chart'));
        if (!canvas || this.chart !== null) {
            return;
        }

        this.chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                datasets: [{
                    label: 'Total',
                    data: [],
                    borderWidth: 1,
                    parsing: { yAxisKey: 'y.total' }
                }, {
                    label: 'Blocked',
                    data: [],
                    borderWidth: 1,
                    parsing: { yAxisKey: 'y.blocked' }
                }]
            },
            options: {
                maintainAspectRatio: false,
                responsive: true,
                elements: {
                    line: {
                        fill: false,
                        cubicInterpolationMode: 'monotone',
                        clip: 0
                    },
                    point: { radius: 0 }
                },
                layout: { padding: { left: 5, right: 10, bottom: 5 } },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            tooltipFormat: 'HH:mm',
                            unit: 'minute',
                            minUnit: 'minute',
                            displayFormats: { minute: 'HH:mm' }
                        }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: { autoSkip: true, autoSkipPadding: 10 }
                    }
                },
                plugins: {
                    legend: { display: true, position: 'top' },
                    tooltip: {
                        mode: 'nearest',
                        intersect: false,
                        callbacks: {
                            label: function(context) {
                                return context.dataset.label + ': ' + (context.parsed.y || 0).toLocaleString();
                            }
                        }
                    }
                }
            }
        });
    }

    async _update() {
        const [totals, rolling] = await Promise.all([
            this.ajaxCall(`/api/unbound/overview/totals/${this.topN}`),
            this.ajaxCall(`/api/unbound/overview/rolling/${this.period}`)
        ]);

        this.lastTotals = totals;
        this._renderStats(totals);
        this._renderTopLists(totals);
        this._updateChart(rolling);
    }

    _renderStats(totals) {
        if (!totals || typeof totals.total !== 'number') {
            return;
        }

        const resolved = (totals.resolved && typeof totals.resolved.total === 'number')
            ? `${totals.resolved.total} (${totals.resolved.pcnt}%)` : '-';
        const blocked = (totals.blocked && typeof totals.blocked.total === 'number')
            ? `${totals.blocked.total} (${totals.blocked.pcnt}%)` : '-';

        $(`#${this._eid('stats')}`).html(`
            <div><b>Total</b><br>${totals.total.toLocaleString()}</div>
            <div><b>Resolved</b><br>${resolved}</div>
            <div><b>Blocked</b><br>${blocked}</div>
            <div><b>Blocklist size</b><br>${(totals.blocklist_size ?? 0).toLocaleString()}</div>
        `);
    }

    _renderTopLists(totals) {
        /* side by side, same as the overview page: #top + #top-blocked */
        this._renderTopList('top', totals ? (totals.top ?? {}) : {}, 'pass');
        this._renderTopList('top-blocked', totals ? (totals.top_blocked ?? {}) : {}, 'block');
    }

    _renderTopList(listName, category, type) {
        const $list = $(`#${this._eid(listName)}`);
        $list.empty();

        /* header row inside the list-group, like overview.volt's static <li> */
        $list.append(`<li class="list-group-item"><b>${type === 'block' ? 'Top blocked domains' : 'Top passed domains'}</b></li>`);

        let index = 0;

        for (const [domain, stat] of Object.entries(category)) {
            if (index >= this.topN) {
                break;
            }
            index++;

            let label = domain;
            if (type === 'block' && stat.latest_policy_uuid && this.policies[stat.latest_policy_uuid]) {
                label += ` (${this.policies[stat.latest_policy_uuid].description})`;
            }

            $list.append(`
                <li class="list-group-item">
                    ${index}. ${label}
                    <span style="float: right;">${(stat.total ?? 0).toLocaleString()} (${stat.pcnt ?? '0'}%)</span>
                </li>
            `);
        }

        if (index === 0) {
            $list.append(`<li class="list-group-item">No entries yet.</li>`);
        }
    }

    _updateChart(rolling) {
        if (!this.chart || !rolling) {
            return;
        }

        const formatted = Object.entries(rolling).map(([ts, values]) => ({
            x: Number(ts) * 1000,
            y: values
        }));

        /* add a trailing zero point to end the time axis properly (same as overview.volt) */
        if (formatted.length > 0) {
            const interval = this.period === '1' ? 60 : 600;
            formatted.push({ x: formatted[formatted.length - 1].x + interval * 1000, y: { total: 0, blocked: 0 } });
        }

        this.chart.options.scales.x.time.stepSize = this.period === '1' ? 5 : 60;
        this.chart.data.datasets.forEach(dataset => {
            dataset.data = formatted;
        });
        this.chart.update();
    }
}
