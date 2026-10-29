"""Pipeline settings. Defaults target a 2-10 minute indoor walkthrough video on one large GPU."""
import dataclasses
import hashlib
import json
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class FramesConfig:
    shift: float = 0.07          # median image motion between keyframes, fraction of width
    min_gap: float = 0.15        # seconds; lets fast camera moves still get enough frames
    max_gap: float = 1.0         # seconds; guarantees >= 1 frame/s
    window: float = 0.2          # seconds searched around a trigger for the sharpest frame
    min_rel_sharp: float = 0.8   # sharpness relative to the +-1 s rolling median
    sharp_width: int = 1920
    flow_width: int = 640
    jpeg_quality: int = 95
    max_frames: int = 2000       # refuse silently huge selections; raise min_gap instead
    start_s: float = 0.0
    end_s: float = 0.0           # 0 = until the end


@dataclass
class SfmConfig:
    max_image_size: int = 3200   # SIFT extraction resolution (long side)
    max_features: int = 8192
    camera_model: str = "OPENCV"
    overlap: int = 20            # sequential neighbours matched per frame
    quadratic_overlap: int = 10  # second pass: +1,+2,+4,... long-range hops
    loop_detection: bool = True  # only if the vocabulary tree can be fetched
    vocab_tree_url: str = ("https://github.com/colmap/colmap/releases/download/3.11.1/"
                           "vocab_tree_faiss_flickr100K_words256K.bin")
    mapper: str = "auto"         # auto = global, then incremental if registration is low
    max_global_error: float = 1.5  # px; above this (or with outlier cameras) the incremental mapper also runs
    outlier_factor: float = 6.0    # cameras farther than this x the median distance from the median centre are outliers
    min_registered: float = 0.5  # below this the job stops; below warn_registered it continues with a warning
    warn_registered: float = 0.9
    train_long_side: int = 1920  # training image size after undistortion


@dataclass
class PriorsConfig:
    enabled: bool = True
    model: str = "Ruicheng/moge-2-vitl-normal"   # MIT code and weights
    resolution_level: int = 9
    min_points: int = 30         # sparse points needed to trust a frame's depth scale
    image_long_side: int = 1920  # training images are undistorted from the original frames at this size (3840: untested)
    prior_long_side: int = 1920  # MoGe maps are stored at this size; training upsamples them


# Per-strategy values of the TrainConfig fields left at None (gsplat simple_trainer's defaults and its mcmc preset).
STRATEGY_DEFAULTS = {"default": {"init_opacity": 0.1, "init_scale": 1.0, "opacity_reg": 0.0, "scale_reg": 0.0},
                     "mcmc": {"init_opacity": 0.5, "init_scale": 0.1, "opacity_reg": 0.01, "scale_reg": 0.01}}


@dataclass
class TrainConfig:
    steps: int = 30_000
    strategy: str = "mcmc"       # "mcmc" (Round 1 room); "default" = original 3DGS densification (untested on GPU)
    cap_max: int = 1_000_000     # mcmc only: gsplat's default; 3M collapsed to fog on a classroom (cause not yet found)
    max_gaussians: int = 6_000_000  # default only: densification stops here (web viewer limit)
    sh_degree: int = 3
    sh_degree_interval: int = 1000
    ssim_lambda: float = 0.2
    opacity_reg: Optional[float] = None  # None = STRATEGY_DEFAULTS
    scale_reg: Optional[float] = None
    init_opacity: Optional[float] = None
    init_scale: Optional[float] = None
    depth_lambda: float = 0.2    # log-depth L1 against aligned priors, decays to depth_lambda_end
    depth_lambda_end: float = 0.02
    normal_lambda: float = 0.05  # 1 - cos against prior normals, from normal_start
    normal_start: int = 3000
    appearance: bool = True      # per-image affine colour correction (exposure / white balance)
    test_every: int = 24         # every Nth frame is held out for evaluation
    checkpoint_every: int = 2500
    preview_every: int = 2500
    max_bad_steps: int = 50      # consecutive non-finite steps before stopping
    min_psnr: float = 16.0       # held-out PSNR below this means training failed; stop before meshing
    normalize_world: bool = True  # train at gsplat's scale (median camera distance 1); export stays metric

    def value(self, name):
        """A field left at None takes the strategy's default."""
        value = getattr(self, name)
        return STRATEGY_DEFAULTS[self.strategy][name] if value is None else value


@dataclass
class MeshConfig:
    voxel: float = 0.02          # metres (scene is metric after the priors stage)
    trunc_voxels: float = 4.0
    max_depth: float = 12.0
    render_long_side: int = 960
    max_views: int = 400
    min_alpha: float = 0.5
    target_triangles: int = 200_000   # viewer limit is 250,000
    min_component_fraction: float = 0.002


@dataclass
class Config:
    frames: FramesConfig = field(default_factory=FramesConfig)
    sfm: SfmConfig = field(default_factory=SfmConfig)
    priors: PriorsConfig = field(default_factory=PriorsConfig)
    train: TrainConfig = field(default_factory=TrainConfig)
    mesh: MeshConfig = field(default_factory=MeshConfig)

    def to_dict(self):
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, data):
        cfg = cls()
        for section, values in (data or {}).items():
            target = getattr(cfg, section)
            for key, value in values.items():
                if not hasattr(target, key):
                    raise KeyError(f"Unknown setting {section}.{key}")
                setattr(target, key, value)
        return cfg

    def stage_hash(self, *sections):
        """Hash of the settings a stage depends on; a change re-runs that stage."""
        blob = json.dumps({s: dataclasses.asdict(getattr(self, s)) for s in sections}, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


def smoke_config():
    """Tiny settings for the end-to-end test that runs before a long job."""
    cfg = Config()
    cfg.frames.end_s = 20.0
    cfg.frames.max_gap = 0.5
    cfg.sfm.max_image_size = 1600
    cfg.sfm.loop_detection = False
    cfg.sfm.min_registered = 0.2  # the smoke test proves the toolchain, not the opening seconds
    cfg.sfm.train_long_side = 960
    cfg.priors.image_long_side = 960
    cfg.priors.prior_long_side = 960
    cfg.train.steps = 1500
    cfg.train.cap_max = 200_000
    cfg.train.max_gaussians = 200_000
    cfg.train.checkpoint_every = 500
    cfg.train.preview_every = 500
    cfg.train.normal_start = 500
    cfg.train.sh_degree_interval = 300
    cfg.train.min_psnr = 12.0  # 1500 steps prove the toolchain, not the final quality
    cfg.mesh.voxel = 0.04
    cfg.mesh.max_views = 60
    cfg.mesh.target_triangles = 50_000
    return cfg
