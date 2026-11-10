ALTER TABLE "inspections" ADD COLUMN "inspected_container" varchar(120);--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "inspected_frame_rate" varchar(32);--> statement-breakpoint
ALTER TABLE "inspections" ADD COLUMN "inspected_streams" jsonb;